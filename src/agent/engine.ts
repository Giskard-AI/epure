import { containsPrivateKeyMaterial } from "../auth/github-apps.js";
import { redactSecrets } from "../auth/issue-command-gate.js";
import type { ProviderConfig } from "../llm/types.js";

export type AgentRole =
  | "implementer"
  | "fixer"
  | "conflict_resolver"
  | "reviewer"
  | "convergence_auditor"
  | "adr_reconciler"
  | "griller"
  | "spec_writer"
  | "ticket_splitter";

// "write" may edit files and run commands in the worktree; "read_only" may only read and search it.
export type AgentToolPolicy = "write" | "read_only";

export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high";

export type FileMode = "100644" | "100755";

// symlink, submodule and binary (incl. non-UTF-8 text) cannot be committed as text; ignored is a new
// file a .gitignore hides; protected is a path the request forbids.
export type SkippedPathReason = "symlink" | "submodule" | "binary" | "ignored" | "protected";

// What a write session left in the worktree, as committable text files.
export interface WorktreeDiff {
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string; readonly mode: FileMode }>;
  readonly deleted_files: readonly string[];
  // Already put back to their state before the session: the worktree holds that state plus files and deleted_files.
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: SkippedPathReason }>;
}

export interface AgentSessionRequest {
  readonly role: AgentRole;
  readonly toolPolicy: AgentToolPolicy;
  // Appended to the engine's own system prompt.
  readonly instructions: string;
  readonly prompt: string;
  // A real checkout the session works in; the diff is taken against its state when the session starts.
  readonly worktree: string;
  readonly timeoutMs: number;
  // "<provider>/<model>", resolved like the direct LLM calls.
  readonly model: string;
  readonly providers?: Readonly<Record<string, ProviderConfig>> | undefined;
  readonly thinking?: AgentThinkingLevel | undefined;
  // Paths the checkout's repository tracks, read before any session wrote to it: kept even when a .gitignore matches.
  readonly trackedPaths?: readonly string[] | undefined;
  // Changes to these paths are reverted and reported as skipped "protected".
  readonly isProtectedPath?: ((path: string) => boolean) | undefined;
  // LLM requests the session may send before it is aborted with AGENT_REQUEST_CAP_REACHED.
  readonly maxLlmRequests?: number | undefined;
  // Values minted during the run (e.g. the installation token) that the diff and final message must not contain.
  readonly secrets?: readonly string[] | undefined;
}

// Token usage is never part of the result. The adapter reports it exactly once (ADR-0035): per response
// through the sandbox LLM proxy or LLMClient, or per session through a usageReporter() bound at the
// start of run(), or as usage_unavailable when the engine cannot tell.
export interface AgentSessionResult {
  readonly finalMessage: string;
  readonly diff: WorktreeDiff;
}

export interface AgentEngine {
  readonly name: string;
  run(request: AgentSessionRequest): Promise<AgentSessionResult>;
}

export type AgentEngineErrorCode =
  | "AGENT_ENGINE_UNAVAILABLE"
  | "AGENT_ISOLATION_UNAVAILABLE"
  | "AGENT_SANDBOX_FAILED"
  | "AGENT_TIMEOUT"
  | "AGENT_REQUEST_CAP_REACHED"
  | "AGENT_PROTOCOL_ERROR"
  | "AGENT_SNAPSHOT_FAILED"
  | "AGENT_DIFF_TOO_LARGE"
  | "AGENT_SECRET_IN_DIFF";

// Provider failures inside a session surface as the LLMError subclasses instead, so escalation stays the same.
export class AgentEngineError extends Error {
  readonly code: AgentEngineErrorCode;

  constructor(code: AgentEngineErrorCode, message: string) {
    super(message);
    this.name = "AgentEngineError";
    this.code = code;
  }
}

// The error names where the secret was found, never the secret itself.
export function assertNoSecretMaterial(
  sources: ReadonlyArray<{ readonly label: string; readonly text: string }>,
  secrets: readonly string[]
): void {
  const values = secrets.map((s) => s.trim()).filter((s) => s.length >= 8);
  const leaking = sources
    .filter((s) => containsPrivateKeyMaterial(s.text) || values.some((v) => s.text.includes(v)))
    .map((s) => redactSecrets(s.label, values));
  if (leaking.length > 0) {
    throw new AgentEngineError(
      "AGENT_SECRET_IN_DIFF",
      `Secret material (a runner secret, the installation token, the proxy nonce or a private key) was found in ${[...new Set(leaking)].join(", ")}; nothing was committed.`
    );
  }
}
