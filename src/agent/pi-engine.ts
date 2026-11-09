import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseModelIdentifier } from "../llm/client.js";
import { classifyHttpError, LLMError } from "../llm/errors.js";
import {
  runInUntrustedCodeSandbox,
  type LlmProxyExchange,
  type LlmProxyResponseObserver,
  type SandboxExecutionInput,
  type SandboxExecutionResult,
  type SandboxSessionIo
} from "../sandbox/llm-sandbox.js";
import {
  AgentEngineError,
  type AgentEngine,
  type AgentSessionRequest,
  type AgentSessionResult,
  type AgentToolPolicy
} from "./engine.js";
import { translateModelForPi } from "./pi-models.js";
import { snapshotWorktree } from "./worktree-snapshot.js";

const PI_TOOLS: Record<AgentToolPolicy, string> = {
  write: "read,bash,edit,write,grep,find,ls",
  read_only: "read,grep,find,ls"
};

const PI_SETTINGS = JSON.stringify({
  enableInstallTelemetry: false,
  enableAnalytics: false,
  defaultProjectTrust: "never"
});

// Time Pi gets to stop after an abort before the sandbox kills it.
const SHUTDOWN_GRACE_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 16 * 1024;
const STDERR_TAIL_CHARS = 2000;

export interface PiAgentEngineOptions {
  readonly runnerEnv: Readonly<Record<string, string | undefined>>;
  readonly piDir?: string | undefined;
  readonly sandboxRunner?:
    | ((input: SandboxExecutionInput) => Promise<SandboxExecutionResult>)
    | undefined;
}

// dist/vendor/pi, seen from the bundled actions (dist/actions/*), the CLI (dist/cli) or the sources (src/agent).
export function resolveVendoredPiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = ["../vendor/pi", "../../vendor/pi", "../../dist/vendor/pi"]
    .map((rel) => resolve(here, rel))
    .find((dir) => existsSync(join(dir, "rpc-entry.js")));
  if (!found) {
    throw new AgentEngineError(
      "AGENT_ENGINE_UNAVAILABLE",
      "The vendored Pi bundle (dist/vendor/pi) is missing; run npm run build."
    );
  }
  return found;
}

interface RpcOutcome {
  settled: boolean;
  timedOut: boolean;
  finalMessage: string;
  lastStopReason?: string | undefined;
  lastErrorMessage?: string | undefined;
  rejected?: string | undefined;
}

interface UpstreamError {
  readonly status: number;
  readonly body: string;
}

export function createPiAgentEngine(options: PiAgentEngineOptions): AgentEngine {
  const sandboxRunner = options.sandboxRunner ?? runInUntrustedCodeSandbox;
  return {
    name: "pi",
    async run(request: AgentSessionRequest): Promise<AgentSessionResult> {
      const piDir = options.piDir ?? resolveVendoredPiDir();
      const route = translateModelForPi(request.model, request.providers, options.runnerEnv);
      const sessionDir = mkdtempSync(join(tmpdir(), "epure-pi-session-"));
      const instructionsPath = join(sessionDir, "instructions.md");
      writeFileSync(instructionsPath, request.instructions, "utf8");
      const snapshot = snapshotWorktree(request.worktree);
      const outcome: RpcOutcome = { settled: false, timedOut: false, finalMessage: "" };
      let upstreamError: UpstreamError | undefined;

      try {
        const result = await sandboxRunner({
          isolationAvailable: true,
          runnerEnv: {
            ...options.runnerEnv,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1"
          },
          command: process.execPath,
          args: [
            join(piDir, "rpc-entry.js"),
            "--no-session",
            "--no-extensions",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--offline",
            "--provider",
            route.provider,
            "--model",
            route.modelId,
            "--tools",
            PI_TOOLS[request.toolPolicy],
            "--append-system-prompt",
            instructionsPath
          ],
          cwd: request.worktree,
          networkPolicy: "proxy_only",
          timeoutMs: request.timeoutMs + SHUTDOWN_GRACE_MS,
          llm: { model: request.model, providers: request.providers },
          readOnlyPaths: [piDir, sessionDir],
          agentSession: {
            homeFiles: (proxy) =>
              proxy
                ? {
                    ".pi/agent/models.json": route.modelsJson(proxy.proxyUrl),
                    ".pi/agent/settings.json": PI_SETTINGS
                  }
                : {}
          },
          observeLlmResponse: (exchange) => {
            if (exchange.status < 400) {
              upstreamError = undefined;
              return undefined;
            }
            return collectErrorBody(exchange, (error) => {
              upstreamError = error;
            });
          },
          interact: (io) => driveRpcSession(io, request.prompt, request.timeoutMs, outcome)
        });

        if (!result.isolated) {
          throw new AgentEngineError("AGENT_SANDBOX_FAILED", result.error_message);
        }
        if (outcome.timedOut) {
          throw new AgentEngineError(
            "AGENT_TIMEOUT",
            `Agent session (${request.role}) exceeded ${request.timeoutMs} ms and was aborted.`
          );
        }
        if (outcome.rejected !== undefined) {
          throw new AgentEngineError("AGENT_PROTOCOL_ERROR", `Pi rejected the prompt: ${outcome.rejected}`);
        }
        if (!outcome.settled) {
          throw new AgentEngineError(
            "AGENT_PROTOCOL_ERROR",
            `Pi exited with code ${result.exit_code} before the session settled: ${result.stderr.slice(-STDERR_TAIL_CHARS)}`
          );
        }
        if (outcome.lastStopReason === "error" || outcome.lastStopReason === "aborted") {
          throw sessionProviderError(request, upstreamError, outcome.lastErrorMessage, options.runnerEnv);
        }
        return { finalMessage: outcome.finalMessage, diff: snapshot.diff() };
      } finally {
        snapshot.dispose();
        rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  };
}

function collectErrorBody(
  exchange: LlmProxyExchange,
  record: (error: UpstreamError) => void
): LlmProxyResponseObserver {
  let body = "";
  const decoder = new TextDecoder();
  return {
    onChunk(chunk) {
      if (body.length < MAX_ERROR_BODY_CHARS) {
        body += decoder.decode(chunk, { stream: true });
      }
    },
    onEnd() {
      record({ status: exchange.status, body: body.slice(0, MAX_ERROR_BODY_CHARS) });
    }
  };
}

function sessionProviderError(
  request: AgentSessionRequest,
  upstreamError: UpstreamError | undefined,
  errorMessage: string | undefined,
  env: Readonly<Record<string, string | undefined>>
): LLMError {
  const { provider, model } = parseModelIdentifier(request.model, request.providers, env);
  if (upstreamError) {
    return classifyHttpError({ status: upstreamError.status, bodyText: upstreamError.body, provider, model });
  }
  return new LLMError(
    `Agent session (${request.role}) failed on ${request.model}: ${errorMessage ?? "no error message"}`,
    { provider }
  );
}

// Pi RPC: JSONL commands on stdin, responses and events on stdout (docs/rpc.md in the Pi package).
async function driveRpcSession(
  io: SandboxSessionIo,
  prompt: string,
  timeoutMs: number,
  outcome: RpcOutcome
): Promise<void> {
  const send = (command: Readonly<Record<string, unknown>>): void => {
    io.stdin.write(`${JSON.stringify(command)}\n`);
  };
  const lines = createInterface({ input: io.stdout, crlfDelay: Infinity });
  const timer = setTimeout(() => {
    outcome.timedOut = true;
    send({ type: "abort" });
  }, timeoutMs);

  try {
    send({ id: "prompt", type: "prompt", message: prompt });
    for await (const line of lines) {
      const record = parseRecord(line);
      if (record?.type === "response" && record.id === "prompt") {
        if (record.success !== true) {
          outcome.rejected = String(record.error ?? "unknown error");
          return;
        }
        // Pi handled the prompt itself (e.g. a leading "/command"): no run starts, so none settles.
        if ((record.data as { disposition?: unknown } | undefined)?.disposition === "handled") {
          send({ id: "final", type: "get_last_assistant_text" });
        }
      } else if (record?.type === "response" && record.id === "final") {
        const data = record.data as { text?: unknown } | undefined;
        outcome.finalMessage = typeof data?.text === "string" ? data.text : "";
        outcome.settled = true;
        return;
      } else if (record?.type === "message_end") {
        const message = record.message as
          | { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
          | undefined;
        if (message?.role === "assistant") {
          outcome.lastStopReason = String(message.stopReason ?? "");
          outcome.lastErrorMessage =
            typeof message.errorMessage === "string" ? message.errorMessage : undefined;
        }
      } else if (record?.type === "agent_settled") {
        send({ id: "final", type: "get_last_assistant_text" });
      }
    }
  } finally {
    clearTimeout(timer);
    lines.close();
    io.stdout.resume();
  }
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
