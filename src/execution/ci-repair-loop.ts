export type CiRepairLoopStatus = "repaired" | "escalated_to_human";

export type CiRepairLoopErrorCode = "NONE" | "MAX_CODE_FIX_ATTEMPTS_EXHAUSTED";

export interface CiAttemptOutcome {
  readonly ciGreen: boolean;
  readonly failureSummary: string;
}

export interface RunBoundedCiRepairLoopInput {
  readonly ticketIssueNumber: number;
  readonly maxCodeFixAttempts: number;
  readonly applyFixAndRunCi: (attemptNumber: number) => Promise<CiAttemptOutcome>;
}

export interface RunBoundedCiRepairLoopResult {
  readonly status: CiRepairLoopStatus;
  readonly error_code: CiRepairLoopErrorCode;
  readonly error_message: string;
  readonly code_fix_attempts_used: number;
  readonly escalated_to_human: boolean;
  readonly last_failure_summary: string;
}

export async function runBoundedCiRepairLoop(
  input: RunBoundedCiRepairLoopInput
): Promise<RunBoundedCiRepairLoopResult> {
  const maxAttempts = Math.max(1, input.maxCodeFixAttempts);
  let attemptsUsed = 0;
  let lastSummary = "";

  while (attemptsUsed < maxAttempts) {
    attemptsUsed += 1;
    const outcome = await input.applyFixAndRunCi(attemptsUsed);
    lastSummary = outcome.failureSummary;

    if (outcome.ciGreen) {
      return {
        status: "repaired",
        error_code: "NONE",
        error_message: "",
        code_fix_attempts_used: attemptsUsed,
        escalated_to_human: false,
        last_failure_summary: ""
      };
    }
  }

  return {
    status: "escalated_to_human",
    error_code: "MAX_CODE_FIX_ATTEMPTS_EXHAUSTED",
    error_message: `CI repair exhausted ${maxAttempts} code-fix attempt(s) on issue #${input.ticketIssueNumber}; escalating to human reviewer (ADR-0012, ADR-0017).`,
    code_fix_attempts_used: attemptsUsed,
    escalated_to_human: true,
    last_failure_summary: lastSummary
  };
}
