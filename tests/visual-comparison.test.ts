import { describe, expect, it } from 'vitest';
import { evaluateVisualComparisonOptIn } from '../src/frontend/visual-comparison.js';

describe('Opt-in desktop/mobile visual comparison (Ticket 35 / Issue #36)', () => {
  it.each([
    {
      scenario: 'skips visual comparison without requiring global check when opt-in is disabled',
      input: {
        optInEnabled: false,
        captures: [],
      },
      expectedExecuted: false,
      expectedPassed: true,
      expectedBaselineSha: null,
    },
    {
      scenario: 'runs desktop and mobile comparison when opt-in is enabled and passes within diff threshold',
      input: {
        optInEnabled: true,
        maxDiffRatio: 0.01,
        captures: [
          {
            viewport: 'desktop' as const,
            width: 1440,
            height: 900,
            diffRatio: 0.002,
            artifactPath: 'artifacts/desktop-diff.png',
          },
          {
            viewport: 'mobile' as const,
            width: 390,
            height: 844,
            diffRatio: 0.004,
            artifactPath: 'artifacts/mobile-diff.png',
          },
        ],
      },
      expectedExecuted: true,
      expectedPassed: true,
      expectedBaselineSha: null,
    },
    {
      scenario: 'fails opt-in visual comparison when mobile diff exceeds threshold without human baseline approval',
      input: {
        optInEnabled: true,
        maxDiffRatio: 0.01,
        captures: [
          {
            viewport: 'desktop' as const,
            width: 1440,
            height: 900,
            diffRatio: 0.001,
            artifactPath: 'artifacts/desktop-diff.png',
          },
          {
            viewport: 'mobile' as const,
            width: 390,
            height: 844,
            diffRatio: 0.045,
            artifactPath: 'artifacts/mobile-diff.png',
          },
        ],
      },
      expectedExecuted: true,
      expectedPassed: false,
      expectedBaselineSha: null,
    },
    {
      scenario: 'records updated baseline traceable to validated revision SHA when approved by human',
      input: {
        optInEnabled: true,
        maxDiffRatio: 0.01,
        baselineApprovedByHuman: true,
        validatedRevisionSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        captures: [
          {
            viewport: 'mobile' as const,
            width: 390,
            height: 844,
            diffRatio: 0.045,
            artifactPath: 'artifacts/mobile-diff.png',
          },
        ],
      },
      expectedExecuted: true,
      expectedPassed: true,
      expectedBaselineSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    },
  ])('$scenario', ({ input, expectedExecuted, expectedPassed, expectedBaselineSha }) => {
    const res = evaluateVisualComparisonOptIn(input);
    expect(res.requiredGlobalCheck).toBe(false);
    expect(res.executed).toBe(expectedExecuted);
    expect(res.passed).toBe(expectedPassed);
    expect(res.baselineUpdatedToSha).toBe(expectedBaselineSha);
  });
});
