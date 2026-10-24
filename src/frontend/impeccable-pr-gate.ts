export type ImpeccableFindingCategory =
  | "wcag_aria_contrast_keyboard"
  | "responsive_layout_overflow"
  | "missing_loading_error_empty_state"
  | "design_md_or_surface_rule"
  | "subjective_aesthetic_suggestion";

export interface ImpeccablePrFinding {
  readonly id: string;
  readonly category: ImpeccableFindingCategory;
  readonly message: string;
  readonly isPreExistingInBaseline: boolean;
  readonly hasApprovedException: boolean;
}

export interface EvaluateImpeccableFrontendPrInput {
  readonly findings: readonly ImpeccablePrFinding[];
}

export interface EvaluateImpeccableFrontendPrResult {
  readonly conclusion: "success" | "failure";
  readonly blocking_findings: readonly ImpeccablePrFinding[];
  readonly informational_findings: readonly ImpeccablePrFinding[];
}

export function evaluateImpeccableFrontendPr(
  input: EvaluateImpeccableFrontendPrInput
): EvaluateImpeccableFrontendPrResult {
  const blocking: ImpeccablePrFinding[] = [];
  const informational: ImpeccablePrFinding[] = [];

  for (const f of input.findings) {
    if (f.isPreExistingInBaseline || f.hasApprovedException) {
      continue;
    }

    if (f.category === "subjective_aesthetic_suggestion") {
      informational.push(f);
      continue;
    }

    blocking.push(f);
  }

  return {
    conclusion: blocking.length === 0 ? "success" : "failure",
    blocking_findings: blocking,
    informational_findings: informational
  };
}
