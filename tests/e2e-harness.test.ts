import { describe, expect, it } from "vitest";
import { createInitialIssueState, type EpureIssueState } from "../src/state/git-ref-state.js";
import { assertE2eSandboxRepository } from "./e2e/config.js";
import { stepProgress } from "./e2e/driver.js";
import {
  decideEscalation,
  escalationReasonFromComment,
  evaluateRun,
  parseUsageLines,
  PhaseClock,
  renderMarkdownReport,
  summarizeUsage,
  type E2eRunResult,
  type EscalationEvent
} from "./e2e/report.js";
import { planSandboxReset, readTreeFiles, SEED_DIR, type SandboxSnapshot } from "./e2e/reset.js";

describe("assertE2eSandboxRepository", () => {
  it.each([
    { id: "e2e-sandbox", repository: "Giskard-AI/epure-e2e-sandbox" },
    { id: "sandbox-in-mixed-case", repository: "someone/My-SandBox-Repo" }
  ])("accepts $id", ({ repository }) => {
    expect(() => assertE2eSandboxRepository(repository)).not.toThrow();
  });

  it.each([
    { id: "name-without-sandbox", repository: "Giskard-AI/epure-e2e", error: /must contain "sandbox"/ },
    { id: "sandbox-only-in-owner", repository: "sandbox-org/app", error: /must contain "sandbox"/ },
    { id: "live-github-sandbox", repository: "Giskard-AI/epure-live-sandbox", error: /reserved/ },
    { id: "live-github-sandbox-other-case", repository: "giskard-ai/EPURE-LIVE-SANDBOX", error: /reserved/ },
    { id: "epure-itself", repository: "Giskard-AI/epure", error: /reserved/ },
    { id: "not-a-slug", repository: "epure-e2e-sandbox", error: /invalid repository slug/ }
  ])("refuses $id", ({ repository, error }) => {
    expect(() => assertE2eSandboxRepository(repository)).toThrow(error);
  });
});

describe("planSandboxReset", () => {
  const empty: SandboxSnapshot = { refs: [], rulesets: [], openPullRequests: [], issues: [], activeRunIds: [] };

  it.each([
    {
      id: "deletes-every-branch-tag-and-state-ref-except-main-and-dev",
      snapshot: {
        ...empty,
        refs: ["refs/heads/main", "refs/heads/dev", "refs/heads/feature/1-x", "refs/heads/task/2-y", "refs/tags/v1.0.0", "refs/epure/state/1"]
      },
      expected: { deleteRefs: ["refs/heads/feature/1-x", "refs/heads/task/2-y", "refs/tags/v1.0.0", "refs/epure/state/1"] }
    },
    {
      id: "ignores-refs-outside-heads-tags-and-epure",
      snapshot: { ...empty, refs: ["refs/pull/3/head", "refs/notes/commits"] },
      expected: { deleteRefs: [] }
    },
    {
      id: "deletes-only-repository-rulesets-named-epure",
      snapshot: {
        ...empty,
        rulesets: [
          { id: 1, name: "epure-dev-governance", source_type: "Repository" },
          { id: 2, name: "Main basic protection", source_type: "Organization" },
          { id: 3, name: "epure-org-wide", source_type: "Organization" },
          { id: 4, name: "team-rule", source_type: "Repository" }
        ]
      },
      expected: { deleteRulesetIds: [1] }
    },
    {
      id: "cancels-active-runs-closes-open-prs-and-deletes-issues",
      snapshot: { ...empty, activeRunIds: [10, 11], openPullRequests: [5], issues: [{ number: 4, node_id: "I_4" }] },
      expected: { cancelRunIds: [10, 11], closePullRequests: [5], deleteIssues: [{ number: 4, node_id: "I_4" }] }
    }
  ])("$id", ({ snapshot, expected }) => {
    expect(planSandboxReset(snapshot)).toMatchObject(expected);
  });
});

describe("seed project", () => {
  it("holds a test suite, a lockfile and a CI workflow named CI", () => {
    const files = readTreeFiles(SEED_DIR);
    const ci = files.find((f) => f.path === ".github/workflows/ci.yml");

    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["package.json", "package-lock.json", "src/stats.js", "test/stats.test.js", ".github/workflows/ci.yml"])
    );
    expect(ci?.content).toMatch(/^name: "CI"$/m);
  });
});

describe("PhaseClock", () => {
  it.each([
    { id: "successful-phase-is-ok", run: () => Promise.resolve("x"), outcome: "ok" },
    { id: "throwing-phase-is-failed-and-rethrows", run: () => Promise.reject(new Error("boom")), outcome: "failed" }
  ] as const)("$id", async ({ run, outcome }) => {
    const ticks = [1_000, 61_000];
    const clock = new PhaseClock(() => ticks.shift()!);

    await clock.time("plan", run).catch(() => undefined);

    expect(clock.phases).toEqual([
      { name: "plan", started_at: "1970-01-01T00:00:01.000Z", ended_at: "1970-01-01T00:01:01.000Z", duration_ms: 60_000, outcome }
    ]);
  });
});

describe("parseUsageLines", () => {
  const usage = { provider: "google", model: "gemini-3.8-flash", input_tokens: 10, cached_input_tokens: 4, output_tokens: 6, thinking_tokens: 2 };

  it.each([
    { id: "line-with-actions-timestamp", log: `2026-11-08T10:00:00.0000000Z epure-llm-usage ${JSON.stringify(usage)}`, expected: [usage] },
    { id: "bare-line", log: `epure-llm-usage ${JSON.stringify(usage)}\r`, expected: [usage] },
    { id: "unrelated-lines", log: "npm ci\nepure: plan ready", expected: [] },
    { id: "truncated-json-is-skipped", log: 'epure-llm-usage {"provider":"goo', expected: [] }
  ])("$id", ({ log, expected }) => {
    expect(parseUsageLines(log)).toEqual(expected);
  });
});

describe("summarizeUsage", () => {
  const record = (model: string, input: number, cached: number, output: number) => ({
    provider: "google",
    model,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    thinking_tokens: 0
  });
  const pricing = { "google/flash": { inputPerMTok: 1, outputPerMTok: 4, cachedInputPerMTok: 0.1 } };

  it.each([
    {
      id: "cached-input-billed-at-cached-price",
      records: [record("flash", 1_000_000, 500_000, 1_000_000)],
      cost: 0.5 + 0.05 + 4
    },
    {
      id: "sums-requests-of-one-model",
      records: [record("flash", 1_000_000, 0, 0), record("flash", 1_000_000, 0, 0)],
      cost: 2
    },
    { id: "unpriced-model-makes-total-unpriced", records: [record("flash", 1, 0, 1), record("pro", 1, 0, 1)], cost: null },
    { id: "no-records-cost-nothing", records: [], cost: 0 }
  ])("$id", ({ records, cost }) => {
    const summary = summarizeUsage(records, pricing);

    expect(summary.total.requests).toBe(records.length);
    if (cost === null) {
      expect(summary.total.cost_usd).toBeNull();
    } else {
      expect(summary.total.cost_usd).toBeCloseTo(cost, 9);
    }
  });
});

describe("escalationReasonFromComment", () => {
  it.each([
    {
      id: "spec-gate-error-code",
      body: "mirror\n\n### ⚠️ Escalade `needs-human` — Échec de validation (`SPEC_GLOSSARY_MISSING`)\n\n- **Code** : `X`",
      expected: "SPEC_GLOSSARY_MISSING"
    },
    { id: "ticket-escalation-without-code", body: "### ⚠️ Escalade humaine (`needs-human`) — ticket #3", expected: null },
    { id: "no-escalation-heading", body: "### Entretien de Cadrage (`/grill-with-docs`)", expected: null }
  ])("$id", ({ body, expected }) => {
    expect(escalationReasonFromComment(body)).toBe(expected);
  });
});

const escalation = (ticket: number, reason = "remediation_exhausted"): EscalationEvent => ({
  reason,
  ticket,
  phase: "implementation",
  at: "2026-11-08T10:00:00.000Z"
});

describe("decideEscalation", () => {
  it.each([
    { id: "first-escalation-of-a-ticket-resumes", earlier: [], event: escalation(3), action: "resume" },
    { id: "escalation-of-another-ticket-resumes", earlier: [escalation(3)], event: escalation(4), action: "resume" },
    { id: "second-escalation-of-a-ticket-stops", earlier: [escalation(3)], event: escalation(3), action: "stop" },
    { id: "internal-error-stops-at-once", earlier: [], event: escalation(3, "internal_error"), action: "stop" }
  ])("$id", ({ earlier, event, action }) => {
    expect(decideEscalation(earlier, event).action).toBe(action);
  });
});

describe("evaluateRun", () => {
  const pr = { number: 9, url: "https://github.com/o/sandbox/pull/9" };

  it.each([
    { id: "open-pr-and-one-escalation-per-ticket-passes", pr, escalations: [escalation(3), escalation(4)], failed: [] },
    { id: "no-feature-pr-fails", pr: null, escalations: [], failed: ["feature-pr-open"] },
    { id: "internal-error-fails", pr, escalations: [escalation(1, "internal_error")], failed: ["no-internal-error-escalation"] },
    { id: "failed-orchestrator-job-fails", pr, escalations: [escalation(1, "orchestrator_job_failed")], failed: ["no-internal-error-escalation"] },
    { id: "two-escalations-on-one-ticket-fail", pr, escalations: [escalation(3), escalation(3)], failed: ["at-most-one-escalation-per-ticket"] }
  ])("$id", ({ pr: featurePr, escalations, failed }) => {
    const { success, checks } = evaluateRun(featurePr, escalations);

    expect(checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(failed);
    expect(success).toBe(failed.length === 0);
  });
});

describe("stepProgress", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  const state = (patch: Partial<EpureIssueState>): EpureIssueState => ({
    ...createInitialIssueState(7),
    version: 5,
    last_processed_comment_id: 100,
    ...patch
  });
  const since = { commentId: 100, version: 4 };

  it.each([
    { id: "no-state-yet", s: null, active: 0, expected: "pending" },
    { id: "comment-not-processed", s: state({ last_processed_comment_id: 99, version: 4 }), active: 0, expected: "pending" },
    { id: "workflow-still-running", s: state({}), active: 1, expected: "pending" },
    {
      id: "live-lease",
      s: state({ claimed_by_run_id: "r1", claim_expires_at: "2026-11-08T11:00:00.000Z" }),
      active: 0,
      expected: "pending"
    },
    {
      id: "stale-lease-is-ignored",
      s: state({ phase: "grilling", status: "active", claimed_by_run_id: "r1", claim_expires_at: "2026-11-08T09:00:00.000Z" }),
      active: 0,
      expected: "settled"
    },
    { id: "awaiting-approval", s: state({ phase: "spec", status: "awaiting_human_approval" }), active: 0, expected: "settled" },
    { id: "suspended", s: state({ status: "suspended" }), active: 0, expected: "suspended" },
    { id: "done", s: state({ phase: "completed", status: "done" }), active: 0, expected: "done" },
    { id: "version-moved-without-cursor", s: state({ last_processed_comment_id: 50, status: "suspended" }), active: 0, expected: "suspended" }
  ])("$id", ({ s, active, expected }) => {
    expect(stepProgress(s, since, active, now)).toBe(expected);
  });
});

describe("renderMarkdownReport", () => {
  it("states the verdict, the failed checks, phase durations, cost and escalations", () => {
    const escalations = [escalation(3)];
    const { success, checks } = evaluateRun(null, escalations);
    const result: E2eRunResult = {
      schema_version: 1,
      run_id: "r1",
      repository: "Giskard-AI/epure-e2e-sandbox",
      epure_ref: "dev",
      epure_sha: "0123456789abcdef",
      model: "google/gemini-3.8-flash",
      started_at: "2026-11-08T10:00:00.000Z",
      ended_at: "2026-11-08T11:00:00.000Z",
      duration_ms: 3_600_000,
      issue: { number: 1, url: "https://github.com/o/sandbox/issues/1" },
      tickets: [3, 4],
      feature_pr: null,
      phases: [{ name: "plan", started_at: "", ended_at: "", duration_ms: 90_000, outcome: "ok" }],
      usage: summarizeUsage([], {}),
      escalations,
      success,
      checks,
      error: "timed out"
    };

    const report = renderMarkdownReport(result);

    expect(report).toContain("# EPURE e2e run r1: FAIL");
    expect(report).toContain("- [ ] feature-pr-open: no open feature/* -> dev pull request");
    expect(report).toContain("| plan | 1.5 min | ok |");
    expect(report).toContain("| total | 0 | 0 (0) | 0 (0) | $0.0000 |");
    expect(report).toContain("- #3 in implementation: `remediation_exhausted`");
    expect(report).toContain("- Harness stopped: timed out");
  });
});
