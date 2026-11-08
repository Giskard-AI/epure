import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../src/llm/client.js";
import { reportLLMUsage } from "../src/llm/usage.js";
import {
  createInMemoryGitRefStateStore,
  formatIssueStateMarker,
  updateIssueStateWithCas,
  type GitRefStateStore
} from "../src/state/git-ref-state.js";
import { meterTokenUsage } from "../src/state/metered-state-store.js";
import {
  addRequestUsage,
  currentTokenUsage,
  MAX_MODELS_PER_RUN,
  OVERFLOW_MODEL,
  runWithTokenUsageLedger,
  TokenUsageLedger,
  totalTokensByModel,
  withUsageAttribution,
  type LLMRequestUsage,
  type TokenUsageRecord,
  type UsageAttribution
} from "../src/usage/token-usage.js";

const known = (input: number, output: number): LLMRequestUsage => ({
  provider: "anthropic",
  model: "claude-x",
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  thinking_tokens: 0
});

const counts = (requests: number, input: number, output: number) => ({
  requests,
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  thinking_tokens: 0
});

describe("addRequestUsage", () => {
  it.each<{
    id: string;
    record: TokenUsageRecord;
    attribution: UsageAttribution;
    usage: LLMRequestUsage;
    expected: TokenUsageRecord;
  }>([
    {
      id: "epic-phase-without-a-ticket-goes-under-epic",
      record: {},
      attribution: { phase: "grilling" },
      usage: known(10, 2),
      expected: { epic: { grilling: { "anthropic/claude-x": counts(1, 10, 2) } } }
    },
    {
      id: "ticket-usage-goes-under-the-ticket-number",
      record: {},
      attribution: { phase: "implementation", ticket: 7 },
      usage: known(10, 2),
      expected: { "7": { implementation: { "anthropic/claude-x": counts(1, 10, 2) } } }
    },
    {
      id: "same-model-and-phase-adds-up",
      record: { "7": { review: { "anthropic/claude-x": counts(1, 10, 2) } } },
      attribution: { phase: "review", ticket: 7 },
      usage: known(5, 1),
      expected: { "7": { review: { "anthropic/claude-x": counts(2, 15, 3) } } }
    },
    {
      id: "engine-without-usage-counts-a-request-as-unavailable-not-zero-tokens",
      record: {},
      attribution: { phase: "implementation", ticket: 3 },
      usage: { provider: "openai", model: "agent", unavailable: true },
      expected: { "3": { implementation: { "openai/agent": { ...counts(1, 0, 0), usage_unavailable: 1 } } } }
    }
  ])("$id", ({ record, attribution, usage, expected }) => {
    expect(addRequestUsage(record, attribution, usage)).toEqual(expected);
  });
});

describe("totalTokensByModel", () => {
  const record: TokenUsageRecord = {
    epic: { grilling: { "anthropic/claude-x": counts(1, 10, 1) } },
    "4": {
      implementation: { "anthropic/claude-x": counts(2, 100, 10), "google/g": counts(1, 5, 5) },
      review: { "google/g": { ...counts(1, 0, 0), usage_unavailable: 1 } }
    }
  };

  it.each([
    {
      id: "whole-epic-sums-every-scope-and-phase",
      scope: undefined,
      expected: {
        "anthropic/claude-x": counts(3, 110, 11),
        "google/g": { ...counts(2, 5, 5), usage_unavailable: 1 }
      }
    },
    {
      id: "one-ticket-sums-its-phases",
      scope: "4",
      expected: { "anthropic/claude-x": counts(2, 100, 10), "google/g": { ...counts(2, 5, 5), usage_unavailable: 1 } }
    },
    { id: "unknown-ticket-is-empty", scope: "9", expected: {} }
  ])("$id", ({ scope, expected }) => {
    expect(totalTokensByModel(record, scope)).toEqual(expected);
  });
});

describe("meterTokenUsage", () => {
  it.each([
    {
      id: "pending-usage-is-written-with-the-next-state-update",
      simulateConflict: false,
      recorded: [known(10, 2)],
      expected: { epic: { plan: { "anthropic/claude-x": counts(1, 10, 2) } } }
    },
    {
      id: "a-cas-conflict-retries-with-the-same-usage-once",
      simulateConflict: true,
      recorded: [known(10, 2), known(1, 1)],
      expected: { epic: { plan: { "anthropic/claude-x": counts(2, 11, 3) } } }
    },
    {
      id: "no-usage-leaves-the-state-without-a-record",
      simulateConflict: false,
      recorded: [],
      expected: undefined
    }
  ])("$id", async ({ simulateConflict, recorded, expected }) => {
    const ledger = new TokenUsageLedger();
    const store = meterTokenUsage(
      createInMemoryGitRefStateStore({ simulateConflictOnFirstWrite: simulateConflict }),
      ledger,
      "refs/epure/state/1"
    );
    for (const usage of recorded) {
      ledger.record({ phase: "plan" }, usage);
    }

    await updateIssueStateWithCas({ issueNumber: 1, store, mutator: (prev) => ({ ...prev, phase: "grilling" }) });

    expect((await store.readRef("refs/epure/state/1")).state?.token_usage).toEqual(expected);
    expect(ledger.pendingCount()).toBe(0);
  });

  it.each([
    { id: "write-that-landed-before-the-connection-failed-is-not-pending-anymore", landsBeforeThrowing: true, expectedPending: 0 },
    { id: "write-that-never-landed-stays-pending", landsBeforeThrowing: false, expectedPending: 1 }
  ])("$id", async ({ landsBeforeThrowing, expectedPending }) => {
    const ledger = new TokenUsageLedger();
    const inner = createInMemoryGitRefStateStore();
    const flaky: GitRefStateStore = {
      readRef: (refName) => inner.readRef(refName),
      compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
        if (landsBeforeThrowing) {
          await inner.compareAndSwapRef(refName, expectedOldSha, nextState);
        }
        throw new Error("socket hang up");
      }
    };
    const store = meterTokenUsage(flaky, ledger, "refs/epure/state/1");
    ledger.record({ phase: "plan" }, known(10, 2));

    await expect(updateIssueStateWithCas({ issueNumber: 1, store, mutator: (prev) => prev })).rejects.toThrow("socket hang up");

    expect(ledger.pendingCount()).toBe(expectedPending);
  });

  it("leaves usage pending on writes to another issue's ref", async () => {
    const ledger = new TokenUsageLedger();
    const store = meterTokenUsage(createInMemoryGitRefStateStore(), ledger, "refs/epure/state/1");
    ledger.record({ phase: "plan" }, known(10, 2));

    await updateIssueStateWithCas({ issueNumber: 2, store, mutator: (prev) => prev });

    expect((await store.readRef("refs/epure/state/2")).state?.token_usage).toBeUndefined();
    expect(ledger.pendingCount()).toBe(1);
  });

  it("does not count written usage twice on later updates", async () => {
    const ledger = new TokenUsageLedger();
    const store = meterTokenUsage(createInMemoryGitRefStateStore(), ledger, "refs/epure/state/1");
    const update = () => updateIssueStateWithCas({ issueNumber: 1, store, mutator: (prev) => prev });

    ledger.record({ phase: "plan" }, known(10, 2));
    await update();
    await update();
    ledger.record({ phase: "spec" }, known(1, 1));
    await update();

    expect((await store.readRef("refs/epure/state/1")).state?.token_usage).toEqual({
      epic: { plan: { "anthropic/claude-x": counts(1, 10, 2) }, spec: { "anthropic/claude-x": counts(1, 1, 1) } }
    });
    expect(ledger.current()).toEqual((await store.readRef("refs/epure/state/1")).state?.token_usage);
  });
});

describe("TokenUsageLedger model cap", () => {
  it.each([
    { id: "models-up-to-the-cap-keep-their-own-key", distinct: MAX_MODELS_PER_RUN, expectedOther: undefined },
    { id: "models-past-the-cap-share-the-overflow-key", distinct: MAX_MODELS_PER_RUN + 3, expectedOther: counts(3, 3, 3) }
  ])("$id", ({ distinct, expectedOther }) => {
    const ledger = new TokenUsageLedger();
    for (let i = 0; i < distinct; i += 1) {
      ledger.record({ phase: "implementation" }, { ...known(1, 1), model: `m-${i}` });
    }
    ledger.record({ phase: "implementation" }, { ...known(1, 1), model: "m-0" });

    const models = ledger.current().epic?.implementation ?? {};
    expect(Object.keys(models)).toHaveLength(Math.min(distinct, MAX_MODELS_PER_RUN) + (expectedOther ? 1 : 0));
    expect(models["anthropic/m-0"]).toEqual(counts(2, 2, 2));
    expect(models[`anthropic/${OVERFLOW_MODEL}`]).toEqual(expectedOther);
  });
});

describe("usage attribution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      id: "nested-attribution-overrides-phase-and-ticket",
      run: () => withUsageAttribution({ phase: "review", ticket: 2 }, async () => reportLLMUsage(known(3, 1))),
      expected: { "2": { review: { "anthropic/claude-x": counts(1, 3, 1) } } }
    },
    {
      id: "outer-attribution-applies-without-an-override",
      run: async () => reportLLMUsage(known(3, 1)),
      expected: { epic: { plan: { "anthropic/claude-x": counts(1, 3, 1) } } }
    }
  ])("$id", async ({ run, expected }) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ledger = new TokenUsageLedger();

    await runWithTokenUsageLedger(ledger, { phase: "plan" }, run);

    expect(ledger.current()).toEqual(expected);
  });

  it.each([
    {
      id: "known-usage-writes-the-log-line",
      usage: known(3, 1),
      lines: 1
    },
    {
      id: "unavailable-usage-writes-no-log-line",
      usage: { provider: "openai", model: "agent", unavailable: true } as const,
      lines: 0
    }
  ])("$id", ({ usage, lines }) => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    reportLLMUsage(usage);

    expect(writes).toHaveLength(lines);
    expect(currentTokenUsage()).toBeUndefined();
  });

  it.each([
    {
      id: "response-with-usage-records-its-tokens",
      body: { candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } },
      expected: { "google/gemini-3.8-flash": counts(1, 4, 2) }
    },
    {
      id: "response-without-usage-records-usage-unavailable",
      body: { candidates: [{ content: { parts: [{ text: "x" }] } }] },
      expected: { "google/gemini-3.8-flash": { ...counts(1, 0, 0), usage_unavailable: 1 } }
    }
  ])("LLMClient $id", async ({ body, expected }) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ledger = new TokenUsageLedger();

    await runWithTokenUsageLedger(ledger, { phase: "spec" }, () =>
      new LLMClient().complete({
        model: "google/gemini-3.8-flash",
        apiKey: "test-key",
        systemInstruction: "test",
        userPrompt: "hi",
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 })
      })
    );

    expect(ledger.current()).toEqual({ epic: { spec: expected } });
  });
});

it("keeps token usage out of the issue state marker", () => {
  const marker = formatIssueStateMarker({
    issue_number: 1,
    version: 1,
    phase: "idle",
    status: "active",
    active_branch: "",
    last_processed_comment_id: 0,
    code_fix_attempts_used: 0,
    transient_retries_used: 0,
    updated_at: "t",
    token_usage: { epic: { plan: { "a/b": counts(1, 1, 1) } } }
  });

  expect(marker).not.toContain("token_usage");
});
