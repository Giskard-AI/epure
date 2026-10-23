export type IdempotentResumeErrorCode =
  | "NONE"
  | "CANCELLED_PLAN_BLOCKS_SIDE_EFFECTS";

export interface ResumeOrPublishInput {
  readonly idempotencyKey: string;
  readonly planCancelled: boolean;
  readonly ticketCancelled: boolean;
  readonly existingGitHubResourceUrl: string | null;
}

export interface ResumeOrPublishResult {
  readonly published: boolean;
  readonly created_new_resource: boolean;
  readonly reused_existing_resource: boolean;
  readonly resource_url: string;
  readonly error_code: IdempotentResumeErrorCode;
  readonly error_message: string;
  readonly existing_artifacts_preserved_for_audit: true;
}

export async function resumeOrPublishWithoutDuplicate(
  input: ResumeOrPublishInput
): Promise<ResumeOrPublishResult> {
  if (input.planCancelled || input.ticketCancelled) {
    return {
      published: false,
      created_new_resource: false,
      reused_existing_resource: false,
      resource_url: "",
      error_code: "CANCELLED_PLAN_BLOCKS_SIDE_EFFECTS",
      error_message:
        "Plan or ticket has been cancelled; late-finishing jobs cannot publish new side effects or merges (ADR-0014, ADR-0017).",
      existing_artifacts_preserved_for_audit: true
    };
  }

  if (
    typeof input.existingGitHubResourceUrl === "string" &&
    input.existingGitHubResourceUrl.trim().length > 0
  ) {
    return {
      published: true,
      created_new_resource: false,
      reused_existing_resource: true,
      resource_url: input.existingGitHubResourceUrl.trim(),
      error_code: "NONE",
      error_message: "",
      existing_artifacts_preserved_for_audit: true
    };
  }

  return {
    published: true,
    created_new_resource: true,
    reused_existing_resource: false,
    resource_url: `https://github.com/resource/${encodeURIComponent(input.idempotencyKey)}`,
    error_code: "NONE",
    error_message: "",
    existing_artifacts_preserved_for_audit: true
  };
}
