import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CursorSdk from "@cursor/sdk";
import { redactSecrets } from "../auth/issue-command-gate.js";
import {
  AuthenticationError as LLMAuthenticationError,
  BadRequestError,
  RateLimitError
} from "../llm/errors.js";
import { collectRunnerSecretValues } from "../sandbox/llm-sandbox.js";
import { isSensitiveTaskBranchPath } from "../sandbox/polyglot-workspace-runner.js";
import { bindToUsageContext, recordTokenUsage } from "../usage/token-usage.js";
import {
  AgentEngineError,
  assertNoSecretMaterial,
  type AgentEngine,
  type AgentSessionRequest,
  type AgentSessionResult,
  type AgentThinkingLevel,
  type AgentToolPolicy,
  type WorktreeDiff
} from "./engine.js";
import { listTrackedPaths, snapshotWorktree } from "./worktree-snapshot.js";

const CURSOR_SDK_SPECIFIER = "@cursor/sdk";
const DEFAULT_MAX_LLM_REQUESTS = 100;
const SECRET_ENV_NAME_RE = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE)/i;

export const CURSOR_ISOLATION_WARNING =
  "harness 'cursor' runs local tools via @cursor/sdk without EPURE's kernel sandbox (Landlock/bubblewrap/Seatbelt) or localhost credential-brokering proxy; CURSOR_API_KEY is held by the in-process SDK session.";

export type CursorSdkModule = Pick<typeof CursorSdk, "Agent"> &
  Partial<
    Pick<
      typeof CursorSdk,
      | "JsonlLocalAgentStore"
      | "AuthenticationError"
      | "ConfigurationError"
      | "CursorAgentError"
      | "CursorSdkError"
    >
  >;

export interface CursorModelTranslation {
  readonly modelId: string;
  readonly providerPrefix: string | null;
  readonly params?: ReadonlyArray<{ readonly id: string; readonly value: string }> | undefined;
}

export interface CursorToolConfig {
  readonly tools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly suppressDefaultShellExecutor: boolean;
}

export interface CursorAgentEngineOptions {
  readonly runnerEnv?: NodeJS.ProcessEnv | undefined;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly sandboxEnabled?: boolean | undefined;
  readonly extraSecrets?: readonly string[] | undefined;
  readonly sdkLoader?: (() => Promise<CursorSdkModule>) | undefined;
}

const READ_ONLY_TOOLS = ["read", "glob", "grep", "ls", "semSearch"] as const;
const READ_ONLY_DISALLOWED_TOOLS = ["edit", "delete", "shell", "task", "mcp"] as const;
const WRITE_TOOLS = ["read", "edit", "delete", "glob", "grep", "ls", "shell", "semSearch"] as const;
const WRITE_DISALLOWED_TOOLS = ["task", "mcp"] as const;

export function translateModelForCursor(
  model: string,
  thinking?: AgentThinkingLevel
): CursorModelTranslation {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new BadRequestError("Model identifier must not be empty.", {
      provider: "cursor",
      status: 400
    });
  }

  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  let providerPrefix: string | null = null;
  let modelId: string;

  if (segments.length <= 1) {
    modelId = segments[0] ?? "";
  } else if (segments[0] === "openrouter" && segments.length >= 3) {
    providerPrefix = "openrouter";
    modelId = segments.slice(2).join("/");
  } else {
    providerPrefix = segments[0] ?? null;
    modelId = segments.slice(1).join("/");
  }

  if (!modelId) {
    throw new BadRequestError(`Invalid model identifier '${model}'.`, {
      provider: "cursor",
      status: 400
    });
  }

  const params = thinking ? [{ id: "thinking", value: thinking }] : undefined;
  return {
    modelId,
    providerPrefix,
    ...(params ? { params } : {})
  };
}

export function resolveCursorToolsForPolicy(toolPolicy: AgentToolPolicy): CursorToolConfig {
  if (toolPolicy === "read_only") {
    return {
      tools: [...READ_ONLY_TOOLS],
      disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS],
      suppressDefaultShellExecutor: true
    };
  }
  return {
    tools: [...WRITE_TOOLS],
    disallowedTools: [...WRITE_DISALLOWED_TOOLS],
    suppressDefaultShellExecutor: false
  };
}

export function buildCursorPrompt(instructions: string, prompt: string): string {
  const trimmedInstructions = instructions.trim();
  if (!trimmedInstructions) {
    return prompt;
  }
  return `<system_instructions>\n${trimmedInstructions}\n</system_instructions>\n\n${prompt}`;
}

async function defaultCursorSdkLoader(): Promise<CursorSdkModule> {
  try {
    return (await import(CURSOR_SDK_SPECIFIER)) as CursorSdkModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AgentEngineError(
      "AGENT_ENGINE_UNAVAILABLE",
      `Failed to load ${CURSOR_SDK_SPECIFIER}: ${detail}`
    );
  }
}

function collectSecretsToRedact(
  apiKey: string,
  runnerEnv: NodeJS.ProcessEnv,
  request: AgentSessionRequest,
  extraSecrets: readonly string[] | undefined
): string[] {
  const secrets = new Set<string>(collectRunnerSecretValues(runnerEnv));
  if (apiKey.length >= 8) {
    secrets.add(apiKey);
  }
  for (const [key, value] of Object.entries(runnerEnv)) {
    if (typeof value === "string" && value.trim().length >= 8 && SECRET_ENV_NAME_RE.test(key)) {
      secrets.add(value.trim());
    }
  }
  for (const provider of Object.values(request.providers ?? {})) {
    if (provider.api_key && provider.api_key.trim().length >= 8) {
      secrets.add(provider.api_key.trim());
    }
  }
  for (const secret of [...(extraSecrets ?? []), ...(request.secrets ?? [])]) {
    if (secret && secret.trim().length >= 8) {
      secrets.add(secret.trim());
    }
  }
  return [...secrets];
}

function redactSecretsFromText(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets);
}

function mapCursorError(err: unknown, secrets: readonly string[]): never {
  if (err instanceof AgentEngineError) {
    throw new AgentEngineError(err.code, redactSecretsFromText(err.message, secrets));
  }
  if (err instanceof LLMAuthenticationError) {
    throw new LLMAuthenticationError(redactSecretsFromText(err.message, secrets), {
      provider: err.provider ?? "cursor",
      status: err.status ?? 401
    });
  }
  if (err instanceof RateLimitError) {
    throw new RateLimitError(redactSecretsFromText(err.message, secrets), {
      provider: err.provider ?? "cursor",
      status: err.status ?? 429
    });
  }
  if (err instanceof BadRequestError) {
    throw new BadRequestError(redactSecretsFromText(err.message, secrets), {
      provider: err.provider ?? "cursor",
      status: err.status ?? 400
    });
  }

  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === "object" &&
          err !== null &&
          "message" in err &&
          typeof (err as { message: unknown }).message === "string"
        ? (err as { message: string }).message
        : String(err);
  const safeMessage = redactSecretsFromText(rawMessage, secrets);
  const errorName = err instanceof Error ? err.name : "";

  if (
    errorName === "AuthenticationError" ||
    /\b(401|403|unauthenticated|unauthorized|invalid[_ -]?api[_ -]?key|authentication failed|not authenticated)\b/i.test(
      safeMessage
    )
  ) {
    throw new LLMAuthenticationError(safeMessage, {
      provider: "cursor",
      status: 401
    });
  }

  if (
    errorName === "RateLimitError" ||
    /\b(429|rate[_ -]?limit|too many requests|resource_exhausted|quota exceeded)\b/i.test(
      safeMessage
    )
  ) {
    throw new RateLimitError(safeMessage, {
      provider: "cursor",
      status: 429
    });
  }

  if (
    errorName === "ConfigurationError" ||
    /\b(400|invalid_argument|bad request|context length|prompt is too long|system prompt override)\b/i.test(
      safeMessage
    )
  ) {
    throw new BadRequestError(safeMessage, {
      provider: "cursor",
      status: 400
    });
  }

  throw new AgentEngineError("AGENT_PROTOCOL_ERROR", safeMessage);
}

export function createCursorAgentEngine(options: CursorAgentEngineOptions = {}): AgentEngine {
  const runnerEnv = options.runnerEnv ?? process.env;
  const loadSdk = options.sdkLoader ?? defaultCursorSdkLoader;

  return {
    name: "cursor",

    async run(request: AgentSessionRequest): Promise<AgentSessionResult> {
      const runInUsageContext = bindToUsageContext();
      const apiKey = (options.apiKey ?? runnerEnv.CURSOR_API_KEY ?? "").trim();
      if (!apiKey) {
        throw new LLMAuthenticationError(
          "Missing CURSOR_API_KEY for the Cursor agent engine. Configure CURSOR_API_KEY in repository Actions secrets.",
          { provider: "cursor", status: 401 }
        );
      }

      const translation = translateModelForCursor(request.model, request.thinking);
      const toolConfig = resolveCursorToolsForPolicy(request.toolPolicy);
      const secrets = collectSecretsToRedact(apiKey, runnerEnv, request, options.extraSecrets);
      const maxLlmRequests = request.maxLlmRequests ?? DEFAULT_MAX_LLM_REQUESTS;
      const readOnly = request.toolPolicy === "read_only";

      console.info(
        `[cursor-engine] session starting (role=${request.role}, policy=${request.toolPolicy}, model=${translation.modelId})`
      );
      console.warn(`[cursor-engine] ${CURSOR_ISOLATION_WARNING}`);

      const sdk = await loadSdk();
      const trackedPaths =
        request.trackedPaths ?? (await listTrackedPaths(request.worktree).catch(() => undefined));
      const snapshot = await snapshotWorktree(request.worktree, {
        trackedPaths,
        isProtectedPath: readOnly
          ? () => true
          : (request.isProtectedPath ?? ((path) => isSensitiveTaskBranchPath(path)))
      });
      const sessionDir = mkdtempSync(join(tmpdir(), "epure-cursor-session-"));

      let agent: CursorSdk.SDKAgent | undefined;
      try {
        const store = sdk.JsonlLocalAgentStore
          ? new sdk.JsonlLocalAgentStore(join(sessionDir, "store"))
          : undefined;

        agent = await sdk.Agent.create({
          apiKey,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          model: {
            id: translation.modelId,
            ...(translation.params ? { params: [...translation.params] } : {})
          },
          tools: [...toolConfig.tools],
          disallowedTools: [...toolConfig.disallowedTools],
          mcpServers: {},
          local: {
            cwd: request.worktree,
            settingSources: [],
            ...(store ? { store } : {}),
            sandboxOptions: {
              enabled: options.sandboxEnabled ?? false
            },
            ...(toolConfig.suppressDefaultShellExecutor
              ? { resourceProviderOptions: { suppressDefaultShellExecutor: true } }
              : {})
          }
        });

        let stepCount = 0;
        let capExceeded = false;
        let timedOut = false;
        let lastAssistantMessage = "";
        let activeRunHandle: CursorSdk.Run | undefined;

        const fullPrompt = buildCursorPrompt(request.instructions, request.prompt);
        const runHandle = await agent.send(fullPrompt, {
          mode: "agent",
          onStep: ({ step }) => {
            if (step.type === "assistantMessage") {
              lastAssistantMessage = step.message.text;
            }
            if (step.type === "assistantMessage" || step.type === "toolCall") {
              stepCount += 1;
              if (stepCount > maxLlmRequests && !capExceeded) {
                capExceeded = true;
                void activeRunHandle?.cancel().catch(() => undefined);
              }
            }
          }
        });
        activeRunHandle = runHandle;
        if (capExceeded) {
          await runHandle.cancel().catch(() => undefined);
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            void runHandle.cancel().catch(() => undefined);
            reject(
              new AgentEngineError(
                "AGENT_TIMEOUT",
                `Agent session (${request.role}) exceeded ${request.timeoutMs} ms and was aborted.`
              )
            );
          }, request.timeoutMs);
        });

        let runResult: CursorSdk.RunResult;
        try {
          runResult = await Promise.race([runHandle.wait(), timeoutPromise]);
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        }

        if (timedOut) {
          throw new AgentEngineError(
            "AGENT_TIMEOUT",
            `Agent session (${request.role}) exceeded ${request.timeoutMs} ms and was aborted.`
          );
        }

        if (capExceeded) {
          throw new AgentEngineError(
            "AGENT_REQUEST_CAP_REACHED",
            `Agent session (${request.role}) was aborted after ${maxLlmRequests} LLM requests.`
          );
        }

        const usage =
          runResult.usage ??
          (await agent
            .getUsage()
            .then((u) => u.usage)
            .catch(() => undefined));
        const usageProvider = translation.providerPrefix ?? "cursor";
        const cachedInputTokens = usage?.cacheReadTokens ?? 0;
        const inputTokens =
          (usage?.inputTokens ?? 0) + (usage?.cacheWriteTokens ?? 0) + cachedInputTokens;
        const outputTokens = usage?.outputTokens ?? 0;
        const thinkingTokens = usage?.reasoningTokens ?? 0;

        if (runResult.error) {
          mapCursorError(runResult.error, secrets);
        }
        if (runResult.status === "error") {
          mapCursorError(new Error("Cursor agent run failed without a detailed error."), secrets);
        }
        if (runResult.status === "cancelled") {
          throw new AgentEngineError("AGENT_PROTOCOL_ERROR", "Cursor agent run was cancelled.");
        }

        runInUsageContext(() => {
          if (usage && (inputTokens > 0 || outputTokens > 0)) {
            recordTokenUsage({
              provider: usageProvider,
              model: translation.modelId,
              input_tokens: inputTokens,
              cached_input_tokens: cachedInputTokens,
              output_tokens: outputTokens,
              thinking_tokens: thinkingTokens
            });
          } else {
            recordTokenUsage({
              provider: usageProvider,
              model: translation.modelId,
              unavailable: true
            });
          }
        });

        const finalMessage = runResult.result ?? lastAssistantMessage;

        const collectedDiff = await snapshot.collect();
        const diff: WorktreeDiff = readOnly
          ? { files: [], deleted_files: [], skipped: [] }
          : collectedDiff;

        assertNoSecretMaterial(
          [
            ...diff.files.map((f) => ({ label: f.path, text: f.content })),
            ...[...diff.files, ...collectedDiff.skipped].map((f) => ({
              label: "a file path",
              text: f.path
            })),
            ...diff.deleted_files.map((path) => ({
              label: "a file path",
              text: path
            })),
            { label: "the final message", text: finalMessage }
          ],
          secrets
        );

        return {
          finalMessage,
          diff
        };
      } catch (err) {
        if (readOnly) {
          await snapshot.collect().catch(() => undefined);
        }
        mapCursorError(err, secrets);
      } finally {
        if (agent) {
          try {
            await agent[Symbol.asyncDispose]();
          } catch {
            // Ignore disposal errors
          }
        }
        snapshot.dispose();
        rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  };
}
