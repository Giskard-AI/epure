export interface ViewportCapture {
  viewport: 'desktop' | 'mobile';
  width: number;
  height: number;
  diffRatio: number;
  artifactPath: string;
}

export interface VisualComparisonInput {
  optInEnabled: boolean;
  maxDiffRatio?: number;
  captures: ViewportCapture[];
  baselineApprovedByHuman?: boolean;
  validatedRevisionSha?: string;
}

export interface VisualComparisonResult {
  executed: boolean;
  requiredGlobalCheck: false;
  passed: boolean;
  exceededViewports: Array<'desktop' | 'mobile'>;
  baselineUpdatedToSha: string | null;
  prSummaryMarkdown: string | null;
}

export function evaluateVisualComparisonOptIn(
  input: VisualComparisonInput
): VisualComparisonResult {
  if (!input.optInEnabled) {
    return {
      executed: false,
      requiredGlobalCheck: false,
      passed: true,
      exceededViewports: [],
      baselineUpdatedToSha: null,
      prSummaryMarkdown: null,
    };
  }

  const maxDiffRatio = input.maxDiffRatio ?? 0.01;
  const exceededViewports = input.captures
    .filter((capture) => capture.diffRatio > maxDiffRatio)
    .map((capture) => capture.viewport);

  if (exceededViewports.length > 0 && input.baselineApprovedByHuman && input.validatedRevisionSha) {
    return {
      executed: true,
      requiredGlobalCheck: false,
      passed: true,
      exceededViewports,
      baselineUpdatedToSha: input.validatedRevisionSha,
      prSummaryMarkdown: `### Visual Comparison (Opt-In)\n- Baseline updated and pinned to validated revision \`${input.validatedRevisionSha}\`.`,
    };
  }

  const passed = exceededViewports.length === 0;
  const rows = input.captures
    .map(
      (c) =>
        `- **${c.viewport}** (${c.width}x${c.height}): diff \`${(c.diffRatio * 100).toFixed(2)}%\` (\`${c.artifactPath}\`)`
    )
    .join('\n');

  return {
    executed: true,
    requiredGlobalCheck: false,
    passed,
    exceededViewports,
    baselineUpdatedToSha: null,
    prSummaryMarkdown: `### Visual Comparison (Opt-In)\n${rows}`,
  };
}
