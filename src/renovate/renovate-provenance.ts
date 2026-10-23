export type RenovateProvenanceErrorCode =
  | "NONE"
  | "SPOOFED_RENOVATE_FORK_FORBIDDEN"
  | "UNVERIFIED_RENOVATE_APP_IDENTITY"
  | "RENOVATE_MUST_TARGET_DEV";

export interface RenovatePrProvenanceInput {
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly authorLogin: string;
  readonly authorType: "User" | "Bot" | string;
  readonly verifiedGitHubAppSlug: string | null;
  readonly expectedRenovateAppSlugs: readonly string[];
}

export interface RenovatePrProvenanceResult {
  readonly authentic_renovate_pr: boolean;
  readonly error_code: RenovateProvenanceErrorCode;
  readonly error_message: string;
  readonly human_approval_required_for_dev_merge: true;
}

export function verifyRenovatePullRequestProvenance(
  input: RenovatePrProvenanceInput
): RenovatePrProvenanceResult {
  if (
    input.headRepository.trim().toLowerCase() !==
    input.baseRepository.trim().toLowerCase()
  ) {
    return {
      authentic_renovate_pr: false,
      error_code: "SPOOFED_RENOVATE_FORK_FORBIDDEN",
      error_message:
        "External fork PRs cannot claim Renovate provenance or trigger privileged migration workflows (ADR-0015, ADR-0016).",
      human_approval_required_for_dev_merge: true
    };
  }

  const allowedSlugs = new Set(
    input.expectedRenovateAppSlugs.map((s) => s.trim().toLowerCase())
  );
  const actualSlug = (input.verifiedGitHubAppSlug ?? "").trim().toLowerCase();

  if (
    input.authorType !== "Bot" ||
    !actualSlug ||
    !allowedSlugs.has(actualSlug)
  ) {
    return {
      authentic_renovate_pr: false,
      error_code: "UNVERIFIED_RENOVATE_APP_IDENTITY",
      error_message:
        "PR author is not a cryptographically verified Renovate GitHub App installation (ADR-0015).",
      human_approval_required_for_dev_merge: true
    };
  }

  const normalizedBase = input.baseBranch.trim().replace(/^refs\/heads\//, "");
  if (normalizedBase !== "dev") {
    return {
      authentic_renovate_pr: false,
      error_code: "RENOVATE_MUST_TARGET_DEV",
      error_message: `Renovate dependency PRs must target 'dev' rather than '${normalizedBase}' (ADR-0015).`,
      human_approval_required_for_dev_merge: true
    };
  }

  return {
    authentic_renovate_pr: true,
    error_code: "NONE",
    error_message: "",
    human_approval_required_for_dev_merge: true
  };
}
