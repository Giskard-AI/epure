import type { ProviderConfig } from "../llm/types.js";
import type { WorktreeDiff } from "./worktree-snapshot.js";

export type AgentRole = "implementer" | "fixer";

// "write" may edit files and run commands in the worktree; "read_only" may only read and search it.
export type AgentToolPolicy = "write" | "read_only";

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
}

// Token usage is not part of the result: it is reported once, by the sandbox LLM proxy (ADR-0035).
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
  | "AGENT_SANDBOX_FAILED"
  | "AGENT_TIMEOUT"
  | "AGENT_PROTOCOL_ERROR";

// Provider failures inside a session surface as the LLMError subclasses instead, so escalation stays the same.
export class AgentEngineError extends Error {
  readonly code: AgentEngineErrorCode;

  constructor(code: AgentEngineErrorCode, message: string) {
    super(message);
    this.name = "AgentEngineError";
    this.code = code;
  }
}
