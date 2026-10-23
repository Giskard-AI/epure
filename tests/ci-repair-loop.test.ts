import { describe, expect, it } from "vitest";
import {
  runBoundedCiRepairLoop,
  type CiAttemptOutcome
} from "../src/execution/ci-repair-loop.js";

describe("Ticket 18 (#19) — Bounded CI repair loop (max_code_fix_attempts: 3) & human escalation", () => {
  it.each([
    {
      id: "repairs-ci-on-second-fix-attempt-within-budget",
      maxCodeFixAttempts: 3,
      outcomes: [
        { ciGreen: false, failureSummary: "Type error in src/index.ts" },
        { ciGreen: true, failureSummary: "" }
      ] satisfies readonly CiAttemptOutcome[],
      expectedStatus: "repaired",
      expectedErrorCode: "NONE",
      expectedAttemptsUsed: 2,
      expectedEscalatedToHuman: false
    },
    {
      id: "escalates-to-human-after-exhausting-3-code-fix-attempts",
      maxCodeFixAttempts: 3,
      outcomes: [
        { ciGreen: false, failureSummary: "Attempt 1 failed" },
        { ciGreen: false, failureSummary: "Attempt 2 failed" },
        { ciGreen: false, failureSummary: "Attempt 3 failed" },
        { ciGreen: true, failureSummary: "Should never reach attempt 4" }
      ] satisfies readonly CiAttemptOutcome[],
      expectedStatus: "escalated_to_human",
      expectedErrorCode: "MAX_CODE_FIX_ATTEMPTS_EXHAUSTED",
      expectedAttemptsUsed: 3,
      expectedEscalatedToHuman: true
    }
  ])(
    "runBoundedCiRepairLoop [$id]: enforces max_code_fix_attempts budget",
    async ({
      maxCodeFixAttempts,
      outcomes,
      expectedStatus,
      expectedErrorCode,
      expectedAttemptsUsed,
      expectedEscalatedToHuman
    }) => {
      let idx = 0;
      const result = await runBoundedCiRepairLoop({
        ticketIssueNumber: 19,
        maxCodeFixAttempts,
        applyFixAndRunCi: async () => {
          const item = outcomes[Math.min(idx, outcomes.length - 1)] ?? {
            ciGreen: false,
            failureSummary: "Failed"
          };
          idx += 1;
          return item;
        }
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.code_fix_attempts_used).toBe(expectedAttemptsUsed);
      expect(result.escalated_to_human).toBe(expectedEscalatedToHuman);
    }
  );
});
