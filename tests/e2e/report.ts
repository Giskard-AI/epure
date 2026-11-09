import { LLM_USAGE_LOG_PREFIX } from "../../src/llm/usage.js";
import {
  addTokenCounts,
  NO_TOKENS,
  totalTokensByModel,
  USAGE_PHASES,
  type LLMTokenUsage,
  type ModelTokenCounts,
  type TokenCounts,
  type TokenUsageRecord
} from "../../src/usage/token-usage.js";
import type { ModelPricing } from "./config.js";
import type { EscalationClass } from "./escalations.js";

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
  // State only: requests among `requests` whose engine reported no usage.
  readonly usage_unavailable?: number | undefined;
}

export interface UsageSummary {
  readonly by_model: Readonly<Record<string, UsageTotals>>;
  readonly total: UsageTotals;
}

export interface UsageLine extends LLMTokenUsage {
  readonly at: string;
}

export interface UsageRecord extends UsageLine {
  readonly run_id: number;
  readonly job_id: number;
  // Harness phase whose window holds `at`, or "unattributed".
  readonly phase: string;
  // `/epure continue` resumes posted before `at`.
  readonly resumes_before: number;
}

const USAGE_LINE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z) ${LLM_USAGE_LOG_PREFIX} (\\{.*\\})\\s*$`
);

// Only the marker right after the Actions timestamp counts: anything echoing it later on a line is not a request.
export function parseUsageLines(log: string): UsageLine[] {
  return log.split("\n").flatMap((line) => {
    const match = USAGE_LINE.exec(line);
    if (!match) {
      return [];
    }
    try {
      const at = new Date(match[1]!.replace(/(\.\d{3})\d+Z$/, "$1Z")).toISOString();
      return [{ ...(JSON.parse(match[2]!) as LLMTokenUsage), at }];
    } catch {
      return [];
    }
  });
}

export interface ResumeEvent {
  readonly at: string;
  readonly ticket: number;
  readonly command: string;
}

export function attributeUsage(
  lines: ReadonlyArray<UsageLine & { readonly run_id: number; readonly job_id: number }>,
  phases: readonly PhaseTiming[],
  resumes: readonly ResumeEvent[]
): UsageRecord[] {
  return lines.map((line) => ({
    ...line,
    phase: phases.find((p) => p.started_at <= line.at && line.at <= p.ended_at)?.name ?? "unattributed",
    resumes_before: resumes.filter((r) => r.at <= line.at).length
  }));
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
  const add = (field: keyof Omit<UsageTotals, "cost_usd" | "usage_unavailable">) => models.reduce((sum, m) => sum + m[field], 0);
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

export function summarizeUsageByPhase(
  records: readonly UsageRecord[],
  pricing: Readonly<Record<string, ModelPricing>>
): Record<string, UsageTotals> {
  const phases = [...new Set(records.map((r) => r.phase))];
  return Object.fromEntries(
    phases.map((phase) => [phase, summarizeUsage(records.filter((r) => r.phase === phase), pricing).total])
  );
}

function totalsOfModels(models: ModelTokenCounts, pricing: Readonly<Record<string, ModelPricing>>): UsageTotals {
  const t = Object.values(models).reduce(addTokenCounts, NO_TOKENS);
  const entries = Object.entries(models);
  return {
    requests: t.requests,
    input_tokens: t.input_tokens,
    cached_input_tokens: t.cached_input_tokens,
    output_tokens: t.output_tokens,
    thinking_tokens: t.thinking_tokens,
    cost_usd: entries.every(([model]) => pricing[model])
      ? entries.reduce((sum, [model, counts]) => sum + costOf(counts, pricing[model]!), 0)
      : null,
    ...(t.usage_unavailable ? { usage_unavailable: t.usage_unavailable } : {})
  };
}

export interface StateUsageSummary {
  readonly by_phase: Readonly<Record<string, UsageTotals>>;
  readonly total: UsageTotals;
}

/** The epic's `token_usage` from refs/epure/state, per EPURE phase across planning and every ticket. */
export function summarizeStateUsage(
  record: TokenUsageRecord,
  pricing: Readonly<Record<string, ModelPricing>>
): StateUsageSummary {
  const by_phase: Record<string, UsageTotals> = {};
  for (const phase of USAGE_PHASES) {
    const models: Record<string, TokenCounts> = {};
    for (const phases of Object.values(record)) {
      for (const [model, counts] of Object.entries(phases[phase] ?? {})) {
        models[model] = addTokenCounts(models[model] ?? NO_TOKENS, counts);
      }
    }
    if (Object.keys(models).length > 0) {
      by_phase[phase] = totalsOfModels(models, pricing);
    }
  }
  return { by_phase, total: totalsOfModels(totalTokensByModel(record), pricing) };
}

const COMPARED_FIELDS = ["requests", "input_tokens", "cached_input_tokens", "output_tokens", "thinking_tokens"] as const;

// A request without usage data writes no log line, so only requests with usage compare.
export function compareStateUsageWithLogs(record: TokenUsageRecord, logs: readonly LLMTokenUsage[]): string[] {
  const fromState = totalTokensByModel(record);
  const fromLogs = summarizeUsage(logs, {}).by_model;
  const models = [...new Set([...Object.keys(fromState), ...Object.keys(fromLogs)])].sort();
  return models.flatMap((model) => {
    const s = fromState[model] ?? NO_TOKENS;
    const state = { ...s, requests: s.requests - (s.usage_unavailable ?? 0) };
    const log = fromLogs[model] ?? { ...NO_TOKENS, cost_usd: null };
    const differing = COMPARED_FIELDS.filter((field) => state[field] !== log[field]);
    return differing.length === 0
      ? []
      : [`${model}: ${differing.map((f) => `${f} ${state[f]} in the state, ${log[f]} in the logs`).join(", ")}`];
  });
}

export interface ActionsJob {
  readonly workflow: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface ActionsMinutes {
  readonly jobs: number;
  readonly minutes: number;
  // GitHub bills each job of a private repository rounded up to the minute.
  readonly billable_minutes: number;
  readonly by_workflow: Readonly<Record<string, number>>;
}

export function actionsMinutes(jobs: readonly ActionsJob[]): ActionsMinutes {
  const timed = jobs.flatMap((job) =>
    job.started_at && job.completed_at
      ? [{ workflow: job.workflow, minutes: Math.max(0, Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000 }]
      : []
  );
  const round = (n: number) => Math.round(n * 100) / 100;
  const by_workflow: Record<string, number> = {};
  for (const job of timed) {
    by_workflow[job.workflow] = round((by_workflow[job.workflow] ?? 0) + job.minutes);
  }
  return {
    jobs: timed.length,
    minutes: round(timed.reduce((sum, job) => sum + job.minutes, 0)),
    billable_minutes: timed.reduce((sum, job) => sum + Math.ceil(job.minutes), 0),
    by_workflow
  };
}

export interface EscalationEvent {
  readonly reason: string;
  readonly class: EscalationClass | "unclassified";
  // The epic issue number when the escalation is not tied to a ticket.
  readonly ticket: number;
  readonly phase: string;
  readonly at: string;
}

export interface JobFailure {
  readonly run_id: number;
  readonly url: string;
  readonly conclusion: string;
  readonly phase: string;
  readonly at: string;
}

export const RESUME_POLICY = {
  resume_command: "/epure continue",
  planning_retry: "re-post the step command",
  max_resumes_per_ticket: 1,
  stops_on: ["internal escalation", "unclassified escalation", "second escalation of a ticket", "failed orchestrator run"]
} as const;

// The spec, ticket and dependency gates suspend without `last_escalation`: their code is the last one in the heading.
export function escalationReasonFromComment(body: string): string | null {
  const heading = body.split("\n").find((line) => line.startsWith("### ⚠️ Escalade"));
  const codes = [...(heading?.matchAll(/`([^`]+)`/g) ?? [])].map((m) => m[1]!).filter((code) => code !== "needs-human");
  return codes.at(-1) ?? null;
}

export function decideEscalation(
  earlier: readonly EscalationEvent[],
  event: EscalationEvent
): { readonly action: "resume" | "stop"; readonly why: string } {
  if (event.class !== "legitimate") {
    return { action: "stop", why: `${event.class} escalation (${event.reason})` };
  }
  if (earlier.some((e) => e.ticket === event.ticket)) {
    return { action: "stop", why: `second escalation on #${event.ticket}` };
  }
  return { action: "resume", why: `first escalation on #${event.ticket}` };
}

export interface SuccessCheck {
  readonly id:
    | "reached-end-state"
    | "feature-pr-open"
    | "no-internal-escalation"
    | "at-most-one-escalation-per-ticket"
    | "no-orchestrator-job-failure"
    | "llm-usage-recorded"
    | "state-usage-matches-job-logs"
    | "gate-3-comment-shows-usage"
    | "feature-pr-body-shows-usage";
  // null: the evidence cannot tell, which does not fail the run.
  readonly passed: boolean | null;
  readonly detail: string;
}

export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

export interface EndState {
  readonly phase: string;
  readonly status: string;
  readonly subphase: string | null;
}

// Gate 3 waits for the human merge after the feature CI passed. completed/done opens the feature PR without that wait
// (synchronous feature integration, feature PR already merged), so such a run is not comparable.
const ACCEPTED_END_STATES = [
  { phase: "review", status: "awaiting_human_approval", label: "Gate 3" },
  { phase: "completed", status: "done", label: "done without the feature CI wait" }
] as const;

export function acceptedEndState(state: Pick<EndState, "phase" | "status"> | null): (typeof ACCEPTED_END_STATES)[number] | null {
  return ACCEPTED_END_STATES.find((s) => s.phase === state?.phase && s.status === state.status) ?? null;
}

const describeState = (s: EndState) => `${s.phase}/${s.status}${s.subphase && s.subphase !== "idle" ? ` (${s.subphase})` : ""}`;

export const GATE_3_HEADING = "### ✅ Feature Pull Request prête pour validation humaine";
const EPIC_TOTAL = /^- \*\*Epic total\*\*: (.+)$/m;
const PR_USAGE_SECTION = /<!-- epure-llm-usage:start -->([\s\S]*?)<!-- epure-llm-usage:end -->/;
const COST = / · (?:≥ )?(?:\$\d+\.\d{2}|< \$0\.01)$/;
const requestsIn = (line: string) => Number(/ · ([\d,]+) requests?\b/.exec(line)?.[1]?.replace(/,/g, "") ?? Number.NaN);

// What is missing from EPURE's usage on a GitHub surface: the epic total with a cost, then each ticket's line.
function usageProblems(text: string, tickets: readonly number[]): string[] {
  const total = EPIC_TOTAL.exec(text)?.[1];
  return [
    ...(total === undefined ? ["no epic total"] : COST.test(total) ? [] : [`no cost in the epic total "${total}"`]),
    ...tickets.flatMap((t) => {
      const line = new RegExp(`^- \\*\\*#${t}\\*\\* .* — LLM usage: (.+)$`, "m").exec(text)?.[1];
      return line === undefined ? [`no usage line for #${t}`] : COST.test(line) ? [] : [`no cost on #${t}`];
    })
  ];
}

// Result fields that are null because reading them failed, with the error.
export type Unknowns = Readonly<Partial<Record<"end_state" | "feature_pr" | "usage" | "actions" | "reviewed_task_prs" | "comments" | "host_clock", string>>>;

export function evaluateRun(input: {
  readonly endState: EndState | null;
  readonly error: string | null;
  readonly featurePr: PullRequestRef | null;
  readonly escalations: readonly EscalationEvent[];
  readonly jobFailures: readonly JobFailure[];
  readonly usageRecords: number;
  readonly unavailableJobLogs: readonly number[];
  // A cancelled job may log usage it never wrote to the state.
  readonly cancelledOrchestratorJobs: readonly number[];
  // compareStateUsageWithLogs; null when the state holds no token usage or either side is unknown.
  readonly stateUsageMismatches: readonly string[] | null;
  // The agent App's last Gate 3 comment, the feature PR body, the plan's tickets and the requests in the state; null when absent or unread.
  readonly gate3Comment: string | null;
  readonly featurePrBody: string | null;
  readonly tickets: readonly number[] | null;
  readonly stateRequests: number | null;
  readonly unknown: Unknowns;
}): { readonly success: boolean; readonly checks: readonly SuccessCheck[] } {
  const { endState, error, featurePr, escalations, jobFailures, usageRecords, unavailableJobLogs, cancelledOrchestratorJobs, stateUsageMismatches, unknown } = input;
  const atGate3 = acceptedEndState(endState)?.label === "Gate 3";
  const gate3Problems = input.gate3Comment === null ? null : usageProblems(input.gate3Comment, input.tickets ?? []);
  const prSection = input.featurePrBody === null ? null : PR_USAGE_SECTION.exec(input.featurePrBody)?.[1] ?? null;
  const prRequests = prSection === null ? Number.NaN : requestsIn(EPIC_TOTAL.exec(prSection)?.[1] ?? "");
  const prProblems =
    prSection === null
      ? null
      : [
          ...usageProblems(prSection, []),
          ...(prRequests === input.stateRequests ? [] : [`${Number.isNaN(prRequests) ? "no" : prRequests} requests in the body, ${input.stateRequests ?? "unknown"} in the state`])
        ];
  const usageMismatch = stateUsageMismatches !== null && stateUsageMismatches.length > 0;
  const accepted = acceptedEndState(endState);
  const internal = escalations.filter((e) => e.class !== "legitimate");
  const perTicket = new Map<number, number>();
  for (const e of escalations) {
    perTicket.set(e.ticket, (perTicket.get(e.ticket) ?? 0) + 1);
  }
  const repeated = [...perTicket].filter(([, n]) => n > 1);
  const checks: SuccessCheck[] = [
    {
      id: "reached-end-state",
      passed: accepted !== null && error === null,
      detail: error
        ? `harness stopped${endState ? ` at ${describeState(endState)}` : ""}: ${error}`
        : endState === null
          ? `EPURE state unknown${unknown.end_state ? `: ${unknown.end_state}` : ""}`
          : accepted
            ? `${describeState(endState)} (${accepted.label})`
            : `${describeState(endState)} is not an accepted end state`
    },
    {
      id: "feature-pr-open",
      passed: featurePr !== null,
      detail: featurePr
        ? `#${featurePr.number} ${featurePr.url}`
        : unknown.feature_pr
          ? `pull requests unknown: ${unknown.feature_pr}`
          : "no open feature/* -> dev pull request"
    },
    {
      id: "no-internal-escalation",
      passed: internal.length === 0,
      detail: internal.length === 0 ? "none" : internal.map((e) => `#${e.ticket} ${e.reason} (${e.class})`).join(", ")
    },
    {
      id: "at-most-one-escalation-per-ticket",
      passed: repeated.length === 0,
      detail: repeated.length === 0 ? "ok" : repeated.map(([t, n]) => `#${t}: ${n}`).join(", ")
    },
    {
      id: "no-orchestrator-job-failure",
      passed: jobFailures.length === 0,
      detail: jobFailures.length === 0 ? "none" : jobFailures.map((f) => `${f.conclusion} ${f.url}`).join(", ")
    },
    {
      id: "llm-usage-recorded",
      passed: usageRecords > 0 && unavailableJobLogs.length === 0 && !unknown.usage,
      detail: unknown.usage
        ? `evidence collection failed: ${unknown.usage}`
        : unavailableJobLogs.length
          ? `no log for orchestrator jobs ${unavailableJobLogs.join(", ")}: cost incomplete`
          : usageRecords > 0
            ? `${usageRecords} requests`
            : "no epure-llm-usage line in the orchestrator logs: cost unknown"
    },
    {
      id: "state-usage-matches-job-logs",
      passed: usageMismatch && cancelledOrchestratorJobs.length > 0 ? null : stateUsageMismatches !== null && !usageMismatch,
      detail: unknown.end_state
        ? `EPURE state unknown: ${unknown.end_state}`
        : unknown.usage
          ? `job logs unknown: ${unknown.usage}`
          : stateUsageMismatches === null
            ? "no token_usage in the EPURE state"
            : !usageMismatch
              ? "no loss and no double write: the state's per-model totals equal the job-log totals"
              : cancelledOrchestratorJobs.length > 0
                ? `orchestrator jobs ${cancelledOrchestratorJobs.join(", ")} were cancelled and may have logged usage they never wrote: ${stateUsageMismatches.join("; ")}`
                : stateUsageMismatches.join("; ")
    },
    {
      id: "gate-3-comment-shows-usage",
      passed: atGate3 ? gate3Problems !== null && gate3Problems.length === 0 : null,
      detail: !atGate3
        ? "EPURE did not reach Gate 3"
        : gate3Problems === null
          ? unknown.comments
            ? `comments unknown: ${unknown.comments}`
            : "no Gate 3 comment from the agent App"
          : gate3Problems.length
            ? gate3Problems.join("; ")
            : `epic total and ${input.tickets?.length ?? 0} ticket lines with a cost`
    },
    {
      id: "feature-pr-body-shows-usage",
      passed: prProblems !== null && prProblems.length === 0,
      detail:
        input.featurePrBody === null
          ? "no feature PR body"
          : prProblems === null
            ? "no epure-llm-usage section in the feature PR body"
            : prProblems.length
              ? prProblems.join("; ")
              : `epic total with a cost and ${prRequests} requests, as in the state`
    }
  ];
  return { success: checks.every((c) => c.passed !== false), checks };
}

export interface Comparability {
  readonly comparable: boolean;
  readonly unmet: readonly string[];
}

export interface HostClock {
  // Real time the harness process did not run: a sleeping host. null when it cannot be told from a clock jump.
  readonly asleep_ms: number | null;
  // How far the local wall clock moved against real time (NTP step, manual change). null without GitHub's time.
  readonly clock_jump_ms: number | null;
}

// Timer drift, the 1 s resolution of GitHub's Date header and short pauses of the WSL VM stay below this.
const HOST_CLOCK_TOLERANCE_MS = 60_000;

// Real elapsed time comes from GitHub's Date header; the monotonic clock stops while the host sleeps.
export function hostClock(elapsed: { readonly wallMs: number; readonly monotonicMs: number; readonly githubMs: number | null }): HostClock {
  if (elapsed.githubMs === null) {
    const drift = Math.round(elapsed.wallMs - elapsed.monotonicMs);
    // Without GitHub's time a wall clock ahead of the monotonic one may be sleep or a jump; behind it can only be a jump.
    return drift < -HOST_CLOCK_TOLERANCE_MS ? { asleep_ms: null, clock_jump_ms: drift } : { asleep_ms: Math.max(0, drift), clock_jump_ms: null };
  }
  return {
    asleep_ms: Math.max(0, Math.round(elapsed.githubMs - elapsed.monotonicMs)),
    clock_jump_ms: Math.round(elapsed.wallMs - elapsed.githubMs)
  };
}

// A run compares with another only when both reached Gate 3 after the same work (two tickets, CI on a task branch,
// a review) on an awake host with a steady clock.
export function assessComparability(input: {
  readonly endState: EndState | null;
  readonly error: string | null;
  // null when the EPURE state could not be read.
  readonly tickets: number | null;
  // null when the workflow runs could not be read.
  readonly taskBranchCiRuns: number | null;
  readonly reviewedTaskPrs: number | null;
  readonly hostClock: HostClock;
}): Comparability {
  const { asleep_ms: asleep, clock_jump_ms: jump } = input.hostClock;
  const unmet = [
    ...(input.error === null ? [] : [`the harness stopped: ${input.error}`]),
    ...(input.endState === null ? ["EPURE end state unknown"] : []),
    ...(input.endState?.phase === "completed" ? ["EPURE ended at completed/done: the feature CI wait was skipped"] : []),
    ...(asleep !== null && asleep > HOST_CLOCK_TOLERANCE_MS
      ? [`the host slept ${(asleep / 60_000).toFixed(1)} min during the run: durations are inflated`]
      : []),
    ...(jump !== null && Math.abs(jump) > HOST_CLOCK_TOLERANCE_MS
      ? [`the local clock jumped ${(jump / 60_000).toFixed(1)} min during the run: durations are wrong`]
      : []),
    ...(input.tickets === null ? ["ticket count unknown"] : input.tickets === 2 ? [] : [`${input.tickets} tickets instead of 2`]),
    ...(input.taskBranchCiRuns === null
      ? ["CI runs on task/* branches unknown: evidence collection failed"]
      : input.taskBranchCiRuns > 0
        ? []
        : ["no CI run on a task/* branch"]),
    ...(input.reviewedTaskPrs === null
      ? ["reviews on task pull requests unknown"]
      : input.reviewedTaskPrs > 0
        ? []
        : ["no review on a task pull request"])
  ];
  return { comparable: unmet.length === 0, unmet };
}

export interface EngineRecord {
  // What ran the epic, read from the installed caller workflow.
  readonly executed: string;
  readonly workflow_actions: readonly string[];
  // `harness` from the generated agents.yml; the in-house loop does not read it.
  readonly agents_yml_harness: string | null;
}

export function deriveEngine(issueCommandWorkflow: string, agentsYml: string): EngineRecord {
  const actions = [...new Set([...issueCommandWorkflow.matchAll(/uses: Giskard-AI\/epure\/actions\/([\w-]+)@/g)].map((m) => m[1]!))];
  const harness = /^harness:\s*(\S+)/m.exec(agentsYml)?.[1] ?? null;
  const executed = actions.includes("run-agent")
    ? `agent harness (${harness ?? "default"})`
    : actions.includes("orchestrate-issue")
      ? harness === null || harness === "pi"
        ? "pi"
        : "epure-in-house-loop"
      : "unknown";
  return { executed, workflow_actions: actions, agents_yml_harness: harness };
}

export interface HarnessSettings {
  readonly model: string;
  readonly thinking_level: string;
  readonly llm_environment: string;
  readonly max_grill_replies: number;
  readonly planning_step_timeout_minutes: number;
  readonly implementation_timeout_minutes: number;
  readonly install_ci_timeout_minutes: number;
  readonly poll_interval_ms: number;
  readonly stall_polls: number;
  // Used instead of stall_polls while EPURE waits for ticket or feature CI.
  readonly ci_wait_stall_polls: number;
}

export interface E2eRunResult {
  readonly schema_version: 4;
  readonly run_id: string;
  readonly repository: string;
  readonly code_under_test: {
    readonly epure_ref: string;
    readonly epure_sha: string;
    readonly harness_commit: string;
  };
  readonly seed: { readonly tree_sha: string; readonly commit_sha: string };
  readonly install_commit_sha: string;
  readonly engine: EngineRecord | null;
  readonly settings: HarnessSettings;
  readonly resume_policy: typeof RESUME_POLICY;
  readonly pricing: { readonly source: string; readonly table: Readonly<Record<string, ModelPricing>> };
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  // start_skew_ms: local clock minus GitHub's at preflight.
  readonly host_clock: HostClock & { readonly start_skew_ms: number | null };
  readonly issue: PullRequestRef | null;
  // accepted: which accepted end state EPURE reached, null for none.
  readonly end_state: (EndState & { readonly accepted: string | null }) | null;
  readonly tickets: readonly number[] | null;
  readonly feature_pr: PullRequestRef | null;
  readonly phases: readonly PhaseTiming[];
  readonly usage:
    | (UsageSummary & {
        readonly by_phase: Readonly<Record<string, UsageTotals>>;
        // Orchestrator jobs that ran but whose log GitHub no longer serves: their requests are missing.
        readonly unavailable_job_logs: readonly number[];
        readonly records: readonly UsageRecord[];
      })
    | null;
  // What EPURE wrote to refs/epure/state; null when the state holds none or could not be read.
  readonly state_usage: StateUsageSummary | null;
  readonly actions: ActionsMinutes | null;
  readonly reviewed_task_prs: number | null;
  readonly escalations: readonly EscalationEvent[];
  readonly resumes: readonly ResumeEvent[];
  readonly job_failures: readonly JobFailure[];
  readonly comparable: Comparability;
  // Why a null field above is null.
  readonly unknown: Unknowns;
  readonly success: boolean;
  readonly checks: readonly SuccessCheck[];
  readonly error: string | null;
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const usd = (cost: number | null) => (cost === null ? "unpriced" : `$${cost.toFixed(4)}`);
const short = (sha: string) => (sha ? sha.slice(0, 12) : "none");
const usageRow = ([name, u]: [string, UsageTotals]) =>
  `| ${name} | ${u.requests} | ${u.input_tokens} (${u.cached_input_tokens}) | ${u.output_tokens} (${u.thinking_tokens}) | ${usd(u.cost_usd)} |`;

export function renderMarkdownReport(r: E2eRunResult): string {
  const lines = [
    `# EPURE e2e run ${r.run_id}: ${r.success ? "PASS" : "FAIL"}`,
    "",
    `- Repository: ${r.repository}`,
    `- EPURE under test: \`${r.code_under_test.epure_ref}\` (${short(r.code_under_test.epure_sha)}); harness commit ${short(r.code_under_test.harness_commit)}`,
    `- Seed tree: ${short(r.seed.tree_sha)}; install commit: ${short(r.install_commit_sha)}`,
    `- Engine: ${r.engine ? `${r.engine.executed} (agents.yml harness: ${r.engine.agents_yml_harness ?? "unset"})` : "not installed"}`,
    `- Model: \`${r.settings.model}\`, thinking ${r.settings.thinking_level}`,
    `- Epic: ${r.issue ? r.issue.url : "not created"}; tickets: ${r.tickets === null ? "unknown" : r.tickets.length ? r.tickets.map((t) => `#${t}`).join(", ") : "none"}`,
    `- End state: ${r.end_state ? `${describeState(r.end_state)}${r.end_state.accepted ? ` (${r.end_state.accepted})` : " (not accepted)"}` : "unknown"}`,
    `- Feature PR: ${r.feature_pr ? r.feature_pr.url : r.unknown.feature_pr ? "unknown" : "none"}`,
    `- Duration: ${minutes(r.duration_ms)}; Actions: ${r.actions ? `${r.actions.minutes} min over ${r.actions.jobs} jobs (${r.actions.billable_minutes} billable)` : "unknown"}`,
    `- Comparable: ${r.comparable.comparable ? "yes" : `no (${r.comparable.unmet.join("; ")})`}`,
    ...(r.error ? [`- Harness stopped: ${r.error}`] : []),
    ...Object.entries(r.unknown).map(([field, why]) => `- Unknown ${field}: ${why}`),
    "",
    "## Success checks",
    "",
    ...r.checks.map((c) => `- [${c.passed ? "x" : " "}] ${c.id}${c.passed === null ? " (unknown)" : ""}: ${c.detail}`),
    "",
    "## Phases",
    "",
    "| Phase | Duration | Outcome |",
    "| --- | --- | --- |",
    ...r.phases.map((p) => `| ${p.name} | ${minutes(p.duration_ms)} | ${p.outcome} |`),
    "",
    `## LLM usage (pricing: ${r.pricing.source || "no source recorded"})`,
    "",
    ...(r.usage === null || r.usage.records.length === 0
      ? ["No usage records: the cost of this run is unknown."]
      : [
          "| Model / phase | Requests | Input (cached) | Output (thinking) | Cost |",
          "| --- | --- | --- | --- | --- |",
          ...Object.entries(r.usage.by_model).map(usageRow),
          ...Object.entries(r.usage.by_phase).map(([phase, u]) => usageRow([`phase ${phase}`, u])),
          usageRow(["total", r.usage.total])
        ]),
    "",
    "## LLM usage recorded in the EPURE state",
    "",
    ...(r.state_usage === null
      ? ["No token usage in the EPURE state."]
      : [
          "| EPURE phase | Requests | Input (cached) | Output (thinking) | Cost |",
          "| --- | --- | --- | --- | --- |",
          ...Object.entries(r.state_usage.by_phase).map(usageRow),
          usageRow(["total", r.state_usage.total]),
          ...(r.state_usage.total.usage_unavailable
            ? ["", `${r.state_usage.total.usage_unavailable} of these requests reported no usage: their tokens are unknown.`]
            : [])
        ]),
    "",
    `## Escalations (${r.escalations.length})`,
    "",
    ...(r.escalations.length
      ? r.escalations.map((e) => `- #${e.ticket} in ${e.phase}: \`${e.reason}\` (${e.class}) at ${e.at}`)
      : ["None."]),
    "",
    `## Orchestrator job failures (${r.job_failures.length})`,
    "",
    ...(r.job_failures.length ? r.job_failures.map((f) => `- ${f.conclusion} in ${f.phase} at ${f.at}: ${f.url}`) : ["None."]),
    ""
  ];
  return lines.join("\n");
}
