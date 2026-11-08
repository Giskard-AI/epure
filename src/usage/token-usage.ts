import { AsyncLocalStorage } from "node:async_hooks";
import { formatLLMUsageLogLine, type LLMRequestUsage } from "../llm/usage.js";
import type { GitRefStateStore } from "../state/git-ref-state.js";

export const USAGE_PHASES = [
  "plan",
  "grilling",
  "spec",
  "tickets",
  "implementation",
  "review",
  "fixes",
  "integration"
] as const;
export type UsagePhase = (typeof USAGE_PHASES)[number];

export interface TokenCounts {
  readonly requests: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly thinking_tokens: number;
  // Requests among `requests` whose engine reported no usage: their tokens are unknown, not zero.
  readonly usage_unavailable?: number | undefined;
}

export type ModelTokenCounts = Readonly<Record<string, TokenCounts>>;

/** `epic` or a ticket number, then the phase, then `<provider>/<model>`. */
export type TokenUsageRecord = Readonly<
  Record<string, Readonly<Partial<Record<UsagePhase, ModelTokenCounts>>>>
>;

export const EPIC_USAGE_SCOPE = "epic";

export interface UsageAttribution {
  readonly phase: UsagePhase;
  // Absent: the epic itself (planning, feature integration).
  readonly ticket?: number | undefined;
}

export const NO_TOKENS: TokenCounts = {
  requests: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0
};

export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const unavailable = (a.usage_unavailable ?? 0) + (b.usage_unavailable ?? 0);
  return {
    requests: a.requests + b.requests,
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    thinking_tokens: a.thinking_tokens + b.thinking_tokens,
    ...(unavailable > 0 ? { usage_unavailable: unavailable } : {})
  };
}

function countsOf(usage: LLMRequestUsage): TokenCounts {
  if ("unavailable" in usage) {
    return { ...NO_TOKENS, requests: 1, usage_unavailable: 1 };
  }
  return {
    requests: 1,
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
    thinking_tokens: usage.thinking_tokens
  };
}

function addToModel(models: ModelTokenCounts, usage: LLMRequestUsage): ModelTokenCounts {
  const model = `${usage.provider}/${usage.model}`;
  return { ...models, [model]: addTokenCounts(models[model] ?? NO_TOKENS, countsOf(usage)) };
}

export function tokensByModel(usages: readonly LLMRequestUsage[]): ModelTokenCounts {
  return usages.reduce(addToModel, {});
}

export function addRequestUsage(
  record: TokenUsageRecord,
  attribution: UsageAttribution,
  usage: LLMRequestUsage
): TokenUsageRecord {
  const scope = attribution.ticket === undefined ? EPIC_USAGE_SCOPE : String(attribution.ticket);
  const phases = record[scope] ?? {};
  return {
    ...record,
    [scope]: { ...phases, [attribution.phase]: addToModel(phases[attribution.phase] ?? {}, usage) }
  };
}

/** Per-model totals of one scope (`epic` or a ticket number), or of the whole epic when omitted. */
export function totalTokensByModel(
  record: TokenUsageRecord,
  scope?: string
): ModelTokenCounts {
  const totals: Record<string, TokenCounts> = {};
  const scopes = scope === undefined ? Object.values(record) : [record[scope] ?? {}];
  for (const phases of scopes) {
    for (const models of Object.values(phases)) {
      for (const [model, counts] of Object.entries(models ?? {})) {
        totals[model] = addTokenCounts(totals[model] ?? NO_TOKENS, counts);
      }
    }
  }
  return totals;
}

interface PendingUsage {
  readonly attribution: UsageAttribution;
  readonly usage: LLMRequestUsage;
}

/** Usage of one run: recorded per request, written to the plan state with its next update. */
export class TokenUsageLedger {
  private pending: PendingUsage[] = [];
  private lastKnown: TokenUsageRecord = {};

  record(attribution: UsageAttribution, usage: LLMRequestUsage): void {
    this.pending.push({ attribution, usage });
  }

  /** The state's record plus the usage this run has not written yet. */
  current(): TokenUsageRecord {
    return this.fold(this.lastKnown, this.pending.length);
  }

  observe(record: TokenUsageRecord | undefined): void {
    this.lastKnown = record ?? {};
  }

  pendingCount(): number {
    return this.pending.length;
  }

  fold(record: TokenUsageRecord | undefined, count: number): TokenUsageRecord {
    return this.pending
      .slice(0, count)
      .reduce((acc, entry) => addRequestUsage(acc, entry.attribution, entry.usage), record ?? {});
  }

  written(record: TokenUsageRecord, count: number): void {
    this.pending = this.pending.slice(count);
    this.lastKnown = record;
  }
}

/** Every state write of the run also writes its pending usage: no extra commit, nothing lost on a retried CAS. */
export function meterTokenUsage(store: GitRefStateStore, ledger: TokenUsageLedger): GitRefStateStore {
  return {
    readRef: async (refName) => {
      const snapshot = await store.readRef(refName);
      ledger.observe(snapshot.state?.token_usage);
      return snapshot;
    },
    compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
      const count = ledger.pendingCount();
      if (count === 0) {
        return store.compareAndSwapRef(refName, expectedOldSha, nextState);
      }
      const token_usage = ledger.fold(nextState.token_usage, count);
      const result = await store.compareAndSwapRef(refName, expectedOldSha, { ...nextState, token_usage });
      if (result.swapped) {
        ledger.written(token_usage, count);
      }
      return result;
    },
    ...(store.listIssueStates ? { listIssueStates: () => store.listIssueStates!() } : {})
  };
}

interface UsageContext {
  readonly ledger: TokenUsageLedger;
  readonly attribution: UsageAttribution;
}

const usageContext = new AsyncLocalStorage<UsageContext>();

export function runWithTokenUsageLedger<T>(
  ledger: TokenUsageLedger,
  attribution: UsageAttribution,
  fn: () => T
): T {
  return usageContext.run({ ledger, attribution }, fn);
}

/** Attributes the LLM usage of `fn` to a phase and/or ticket; a no-op outside a metered run. */
export function withUsageAttribution<T>(
  attribution: Partial<UsageAttribution>,
  fn: () => Promise<T>
): Promise<T> {
  const parent = usageContext.getStore();
  if (!parent) {
    return fn();
  }
  return usageContext.run({ ledger: parent.ledger, attribution: { ...parent.attribution, ...attribution } }, fn);
}

export function currentTokenUsage(): TokenUsageRecord | undefined {
  return usageContext.getStore()?.ledger.current();
}

/** One `epure-llm-usage` log line per response with known usage, and the run's ledger. */
export function reportLLMUsage(usage: LLMRequestUsage): void {
  if (!("unavailable" in usage)) {
    process.stdout.write(`${formatLLMUsageLogLine(usage)}\n`);
  }
  const context = usageContext.getStore();
  context?.ledger.record(context.attribution, usage);
}

/** reportLLMUsage bound to the caller's attribution, for callbacks that run outside it (a proxy's server). */
export function usageReporter(): (usage: LLMRequestUsage) => void {
  const inCallerContext = AsyncLocalStorage.snapshot();
  return (usage) => inCallerContext(() => reportLLMUsage(usage));
}
