import { describe, expect, it } from 'vitest';
import { evaluateDevToMainPromotion, type ReleasePromotionInput } from '../src/release/promote-dev-to-main.js';

const baseValidInput: ReleasePromotionInput = {
  appRole: 'release',
  agentAppId: '1001',
  releaseAppId: '2002',
  workflowPath: '.github/workflows/release.yml',
  environmentName: 'release',
  releaseEnvironmentApproved: true,
  semverTag: 'v1.0.0',
  expectedDevSha: 'aaa111',
  currentDevSha: 'aaa111',
  currentMainSha: '000000',
  isMainAncestorOfDev: true,
  devRequiredCiGreen: true,
  existingTagTargetSha: null,
};

describe('Manual fast-forward promotion dev -> main (Ticket 36 / Issue #37)', () => {
  it.each([
    {
      scenario: 'promotes dev to main by strict fast-forward with immutable SemVer tag when Release App and environment are approved',
      input: baseValidInput,
      expectedAllowed: true,
      expectedReason: 'RELEASE_PROMOTED_FF_ONLY',
      expectedCommand: 'git push origin dev:main --ff-only',
      expectedTagRef: 'refs/tags/v1.0.0',
    },
    {
      scenario: 'rejects promotion when invoked by Agent App instead of Release App',
      input: {
        ...baseValidInput,
        appRole: 'agent' as const,
      },
      expectedAllowed: false,
      expectedReason: 'UNAUTHORIZED_RELEASE_ACTOR',
      expectedCommand: null,
      expectedTagRef: null,
    },
    {
      scenario: 'rejects promotion when floating tag v1 or non-SemVer tag is requested',
      input: {
        ...baseValidInput,
        semverTag: 'v1',
      },
      expectedAllowed: false,
      expectedReason: 'INVALID_SEMVER_TAG',
      expectedCommand: null,
      expectedTagRef: null,
    },
    {
      scenario: 'rejects promotion when main has diverged from dev (non-fast-forwardable)',
      input: {
        ...baseValidInput,
        currentMainSha: '999999',
        isMainAncestorOfDev: false,
      },
      expectedAllowed: false,
      expectedReason: 'MAIN_NOT_FAST_FORWARDABLE',
      expectedCommand: null,
      expectedTagRef: null,
    },
    {
      scenario: 'rejects promotion when dev SHA changed since dispatch',
      input: {
        ...baseValidInput,
        currentDevSha: 'bbb222',
      },
      expectedAllowed: false,
      expectedReason: 'DEV_SHA_CHANGED',
      expectedCommand: null,
      expectedTagRef: null,
    },
    {
      scenario: 'rejects promotion when existing SemVer tag points to a contradictory SHA',
      input: {
        ...baseValidInput,
        existingTagTargetSha: 'ccc333',
      },
      expectedAllowed: false,
      expectedReason: 'CONTRADICTORY_EXISTING_TAG',
      expectedCommand: null,
      expectedTagRef: null,
    },
  ])('$scenario', ({ input, expectedAllowed, expectedReason, expectedCommand, expectedTagRef }) => {
    const res = evaluateDevToMainPromotion(input);
    expect(res.allowed).toBe(expectedAllowed);
    expect(res.reasonCode).toBe(expectedReason);
    expect(res.fastForwardCommand).toBe(expectedCommand);
    expect(res.immutableTagRef).toBe(expectedTagRef);
  });
});
