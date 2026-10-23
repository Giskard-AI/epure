import { describe, expect, it } from "vitest";
import {
  verifyBugfixRegressionTddGate,
  type BugfixTddGateInput
} from "../src/execution/bugfix-tdd-gate.js";

describe("Ticket 20 (#21) — Require failing reproduction test before bugfix (red -> green TDD)", () => {
  it.each([
    {
      id: "accepts-bugfix-with-regression-test-that-failed-before-and-passed-after",
      input: {
        ticketIssueNumber: 21,
        changedFiles: ["src/parser.ts", "tests/parser-regression.test.ts"],
        reproductionTestFailedBeforeFix: true,
        regressionTestPassedAfterFix: true
      } satisfies BugfixTddGateInput,
      expectedValid: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "rejects-bugfix-without-regression-test-file",
      input: {
        ticketIssueNumber: 21,
        changedFiles: ["src/parser.ts"],
        reproductionTestFailedBeforeFix: true,
        regressionTestPassedAfterFix: true
      } satisfies BugfixTddGateInput,
      expectedValid: false,
      expectedErrorCode: "REGRESSION_TEST_MISSING"
    },
    {
      id: "rejects-bugfix-when-reproduction-test-did-not-fail-before-fix",
      input: {
        ticketIssueNumber: 21,
        changedFiles: ["src/parser.ts", "tests/parser-regression.test.ts"],
        reproductionTestFailedBeforeFix: false,
        regressionTestPassedAfterFix: true
      } satisfies BugfixTddGateInput,
      expectedValid: false,
      expectedErrorCode: "REPRODUCTION_TEST_DID_NOT_FAIL_BEFORE_FIX"
    },
    {
      id: "rejects-bugfix-when-regression-test-fails-after-fix",
      input: {
        ticketIssueNumber: 21,
        changedFiles: ["src/parser.ts", "tests/parser-regression.test.ts"],
        reproductionTestFailedBeforeFix: true,
        regressionTestPassedAfterFix: false
      } satisfies BugfixTddGateInput,
      expectedValid: false,
      expectedErrorCode: "REGRESSION_TEST_FAILED_AFTER_FIX"
    }
  ])(
    "verifyBugfixRegressionTddGate [$id]: enforces red -> green regression test gate",
    ({ input, expectedValid, expectedErrorCode }) => {
      const result = verifyBugfixRegressionTddGate(input);
      expect(result.valid).toBe(expectedValid);
      expect(result.error_code).toBe(expectedErrorCode);
    }
  );
});
