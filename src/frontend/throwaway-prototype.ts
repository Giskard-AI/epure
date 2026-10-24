export type ThrowawayPrototypeErrorCode =
  | "NONE"
  | "EXPLORATORY_PROTOTYPE_CODE_REUSE_FORBIDDEN";

export interface ThrowawayPrototypeInput {
  readonly issueNumber: number;
  readonly topicSlug: string;
  readonly hasUnresolvedDesignUncertainty: boolean;
  readonly prototypeConclusionSummary: string;
  readonly screenshotsAttached: readonly string[];
  readonly productionStartBaseBranch: string;
  readonly copiedExploratoryPrototypeFilesIntoProduction: readonly string[];
}

export interface ThrowawayPrototypeResult {
  readonly prototype_created: boolean;
  readonly prototype_branch: string;
  readonly production_branch_clean: boolean;
  readonly error_code: ThrowawayPrototypeErrorCode;
  readonly error_message: string;
}

export function evaluateThrowawayPrototypeIsolation(
  input: ThrowawayPrototypeInput
): ThrowawayPrototypeResult {
  const cleanSlug = input.topicSlug.trim().replace(/^\/+|\/+$/g, "");
  const prototypeBranch = input.hasUnresolvedDesignUncertainty
    ? `prototype/${input.issueNumber}-${cleanSlug}`
    : "";

  const baseBranch = input.productionStartBaseBranch
    .trim()
    .replace(/^refs\/heads\//, "");

  if (
    baseBranch.startsWith("prototype/") ||
    input.copiedExploratoryPrototypeFilesIntoProduction.length > 0
  ) {
    return {
      prototype_created: input.hasUnresolvedDesignUncertainty,
      prototype_branch: prototypeBranch,
      production_branch_clean: false,
      error_code: "EXPLORATORY_PROTOTYPE_CODE_REUSE_FORBIDDEN",
      error_message:
        "Throwaway prototype code must never be merged or copied into production branches; only documented design conclusions may be re-injected into the spec (ADR-0021)."
    };
  }

  return {
    prototype_created: input.hasUnresolvedDesignUncertainty,
    prototype_branch: prototypeBranch,
    production_branch_clean: true,
    error_code: "NONE",
    error_message: ""
  };
}
