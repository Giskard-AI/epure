import { LLM_USAGE_LOG_PREFIX, type LLMTokenUsage } from "../../src/llm/usage.js";
import type { ModelPricing } from "./config.js";

export interface PhaseTiming {
  readonly name: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly outcome: "ok" | "failed";
}

export class PhaseClock {
  readonly phases: PhaseTiming[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async time<T>(name: string, run: () => Promise<T>): Promise<T> {
    const start = this.now();
    const record = (outcome: PhaseTiming["outcome"]) => {
      const end = this.now();
      this.phases.push({
        name,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(end).toISOString(),
        duration_ms: end - start,
        outcome
      });
    };
    try {
      const result = await run();
      record("ok");
      return result;
    } catch (err) {
      record("failed");
      throw err;
    }
  }
}

export interface UsageTotals {
  readonly requests: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly thinking_tokens: number;
  // null when the model has no entry in the pricing table.
  readonly cost_usd: number | null;
}

export interface UsageSummary {
  readonly by_model: Readonly<Record<string, UsageTotals>>;
  readonly total: UsageTotals;
}

export function parseUsageLines(log: string): LLMTokenUsage[] {
  // Actions prefixes every log line with a timestamp, so the marker can sit anywhere on the line.
  const marker = `${LLM_USAGE_LOG_PREFIX} `;
  return log.split("\n").flatMap((line) => {
    const at = line.indexOf(marker);
    if (at < 0) {
      return [];
    }
    try {
      return [JSON.parse(line.slice(at + marker.length).trim()) as LLMTokenUsage];
    } catch {
      return [];
    }
  });
}

function costOf(t: Omit<UsageTotals, "cost_usd" | "requests">, price: ModelPricing): number {
  const uncached = t.input_tokens - t.cached_input_tokens;
  const cachedPrice = price.cachedInputPerMTok ?? price.inputPerMTok;
  return (uncached * price.inputPerMTok + t.cached_input_tokens * cachedPrice + t.output_tokens * price.outputPerMTok) / 1e6;
}

export function summarizeUsage(
  records: readonly LLMTokenUsage[],
  pricing: Readonly<Record<string, ModelPricing>>
): UsageSummary {
  const sums = new Map<string, Omit<UsageTotals, "cost_usd">>();
  for (const r of records) {
    const key = `${r.provider}/${r.model}`;
    const s = sums.get(key) ?? { requests: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
    sums.set(key, {
      requests: s.requests + 1,
      input_tokens: s.input_tokens + r.input_tokens,
      cached_input_tokens: s.cached_input_tokens + r.cached_input_tokens,
      output_tokens: s.output_tokens + r.output_tokens,
      thinking_tokens: s.thinking_tokens + r.thinking_tokens
    });
  }
  const by_model: Record<string, UsageTotals> = {};
  for (const [key, s] of sums) {
    const price = pricing[key];
    by_model[key] = { ...s, cost_usd: price ? costOf(s, price) : null };
  }
  const models = Object.values(by_model);
  const add = (field: keyof Omit<UsageTotals, "cost_usd">) => models.reduce((sum, m) => sum + m[field], 0);
  return {
    by_model,
    total: {
      requests: add("requests"),
      input_tokens: add("input_tokens"),
      cached_input_tokens: add("cached_input_tokens"),
      output_tokens: add("output_tokens"),
      thinking_tokens: add("thinking_tokens"),
      cost_usd: models.some((m) => m.cost_usd === null) ? null : models.reduce((sum, m) => sum + (m.cost_usd ?? 0), 0)
    }
  };
}

export interface EscalationEvent {
  readonly reason: string;
  // The epic issue number when the escalation is not tied to a ticket.
  readonly ticket: number;
  readonly phase: string;
  readonly at: string;
}

export const INTERNAL_ERROR_REASONS = new Set(["internal_error", "orchestrator_job_failed"]);

// The spec gate suspends without `last_escalation`: its reason is the code in the comment heading.
export function escalationReasonFromComment(body: string): string | null {
  const heading = body.split("\n").find((line) => line.startsWith("### ⚠️ Escalade"));
  const codes = [...(heading?.matchAll(/`([^`]+)`/g) ?? [])].map((m) => m[1]!).filter((code) => code !== "needs-human");
  return codes.at(-1) ?? null;
}

export function decideEscalation(
  earlier: readonly EscalationEvent[],
  event: EscalationEvent
): { readonly action: "resume" | "stop"; readonly why: string } {
  if (INTERNAL_ERROR_REASONS.has(event.reason)) {
    return { action: "stop", why: `internal error (${event.reason})` };
  }
  if (earlier.some((e) => e.ticket === event.ticket)) {
    return { action: "stop", why: `second escalation on #${event.ticket}` };
  }
  return { action: "resume", why: `first escalation on #${event.ticket}` };
}

export interface SuccessCheck {
  readonly id: "feature-pr-open" | "no-internal-error-escalation" | "at-most-one-escalation-per-ticket";
  readonly passed: boolean;
  readonly detail: string;
}

export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

export function evaluateRun(featurePr: PullRequestRef | null, escalations: readonly EscalationEvent[]): {
  readonly success: boolean;
  readonly checks: readonly SuccessCheck[];
} {
  const internal = escalations.filter((e) => INTERNAL_ERROR_REASONS.has(e.reason));
  const perTicket = new Map<number, number>();
  for (const e of escalations) {
    perTicket.set(e.ticket, (perTicket.get(e.ticket) ?? 0) + 1);
  }
  const repeated = [...perTicket].filter(([, n]) => n > 1);
  const checks: SuccessCheck[] = [
    {
      id: "feature-pr-open",
      passed: featurePr !== null,
      detail: featurePr ? `#${featurePr.number} ${featurePr.url}` : "no open feature/* -> dev pull request"
    },
    {
      id: "no-internal-error-escalation",
      passed: internal.length === 0,
      detail: internal.length === 0 ? "none" : internal.map((e) => `#${e.ticket} ${e.reason}`).join(", ")
    },
    {
      id: "at-most-one-escalation-per-ticket",
      passed: repeated.length === 0,
      detail: repeated.length === 0 ? "ok" : repeated.map(([t, n]) => `#${t}: ${n}`).join(", ")
    }
  ];
  return { success: checks.every((c) => c.passed), checks };
}

export interface E2eRunResult {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly repository: string;
  readonly epure_ref: string;
  readonly epure_sha: string;
  readonly model: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly issue: PullRequestRef | null;
  readonly tickets: readonly number[];
  readonly feature_pr: PullRequestRef | null;
  readonly phases: readonly PhaseTiming[];
  readonly usage: UsageSummary;
  readonly escalations: readonly EscalationEvent[];
  readonly success: boolean;
  readonly checks: readonly SuccessCheck[];
  readonly error: string | null;
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const usd = (cost: number | null) => (cost === null ? "unpriced" : `$${cost.toFixed(4)}`);

export function renderMarkdownReport(r: E2eRunResult): string {
  const lines = [
    `# EPURE e2e run ${r.run_id}: ${r.success ? "PASS" : "FAIL"}`,
    "",
    `- Repository: ${r.repository}`,
    `- EPURE under test: \`${r.epure_ref}\` (${r.epure_sha.slice(0, 12)})`,
    `- Model: \`${r.model}\``,
    `- Epic: ${r.issue ? r.issue.url : "not created"}; tickets: ${r.tickets.length ? r.tickets.map((t) => `#${t}`).join(", ") : "none"}`,
    `- Feature PR: ${r.feature_pr ? r.feature_pr.url : "none"}`,
    `- Duration: ${minutes(r.duration_ms)}`,
    ...(r.error ? [`- Harness stopped: ${r.error}`] : []),
    "",
    "## Success checks",
    "",
    ...r.checks.map((c) => `- [${c.passed ? "x" : " "}] ${c.id}: ${c.detail}`),
    "",
    "## Phases",
    "",
    "| Phase | Duration | Outcome |",
    "| --- | --- | --- |",
    ...r.phases.map((p) => `| ${p.name} | ${minutes(p.duration_ms)} | ${p.outcome} |`),
    "",
    "## LLM usage",
    "",
    "| Model | Requests | Input (cached) | Output (thinking) | Cost |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries({ ...r.usage.by_model, total: r.usage.total }).map(
      ([model, u]) =>
        `| ${model} | ${u.requests} | ${u.input_tokens} (${u.cached_input_tokens}) | ${u.output_tokens} (${u.thinking_tokens}) | ${usd(u.cost_usd)} |`
    ),
    "",
    `## Escalations (${r.escalations.length})`,
    "",
    ...(r.escalations.length
      ? r.escalations.map((e) => `- #${e.ticket} in ${e.phase}: \`${e.reason}\` at ${e.at}`)
      : ["None."]),
    ""
  ];
  return lines.join("\n");
}
