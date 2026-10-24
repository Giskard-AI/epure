export type BugfixTddGateErrorCode =
  | "NONE"
  | "REGRESSION_TEST_MISSING"
  | "REPRODUCTION_TEST_DID_NOT_FAIL_BEFORE_FIX"
  | "REGRESSION_TEST_FAILED_AFTER_FIX";

export interface BugfixTddGateInput {
  readonly ticketIssueNumber: number;
  readonly changedFiles: readonly string[];
  readonly reproductionTestFailedBeforeFix: boolean;
  readonly regressionTestPassedAfterFix: boolean;
}

export interface BugfixTddGateResult {
  readonly valid: boolean;
  readonly error_code: BugfixTddGateErrorCode;
  readonly error_message: string;
  readonly regression_test_files: readonly string[];
}

const TEST_FILE_PATTERN =
  /(?:^|\/)(?:tests?|__tests__)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export function verifyBugfixRegressionTddGate(
  input: BugfixTddGateInput
): BugfixTddGateResult {
  const testFiles = input.changedFiles.filter((f) =>
    TEST_FILE_PATTERN.test(f.trim())
  );

  if (testFiles.length === 0) {
    return {
      valid: false,
      error_code: "REGRESSION_TEST_MISSING",
      error_message: `Bugfix on issue #${input.ticketIssueNumber} must include at least one regression test file (ADR-0006).`,
      regression_test_files: []
    };
  }

  if (!input.reproductionTestFailedBeforeFix) {
    return {
      valid: false,
      error_code: "REPRODUCTION_TEST_DID_NOT_FAIL_BEFORE_FIX",
      error_message:
        "Reproduction test must fail before applying the bug fix (red -> green TDD).",
      regression_test_files: testFiles
    };
  }

  if (!input.regressionTestPassedAfterFix) {
    return {
      valid: false,
      error_code: "REGRESSION_TEST_FAILED_AFTER_FIX",
      error_message:
        "Regression test suite must pass after applying the bug fix.",
      regression_test_files: testFiles
    };
  }

  return {
    valid: true,
    error_code: "NONE",
    error_message: "",
    regression_test_files: testFiles
  };
}
