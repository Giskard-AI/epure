import { verifyAppRoleBoundary, type EpureAppRole } from '../auth/github-apps.js';

export const IMMUTABLE_SEMVER_TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export interface ReleasePromotionInput {
  appRole: EpureAppRole;
  agentAppId: string;
  releaseAppId: string;
  workflowPath: string;
  environmentName: string;
  releaseEnvironmentApproved: boolean;
  semverTag: string;
  expectedDevSha: string;
  currentDevSha: string;
  currentMainSha: string;
  isMainAncestorOfDev: boolean;
  devRequiredCiGreen: boolean;
  existingTagTargetSha: string | null;
}

export interface ReleasePromotionResult {
  allowed: boolean;
  promotedSha: string | null;
  fastForwardCommand: string | null;
  immutableTagRef: string | null;
  reasonCode:
    | 'RELEASE_PROMOTED_FF_ONLY'
    | 'UNAUTHORIZED_RELEASE_ACTOR'
    | 'MISSING_RELEASE_ENVIRONMENT_APPROVAL'
    | 'INVALID_SEMVER_TAG'
    | 'DEV_SHA_CHANGED'
    | 'MAIN_NOT_FAST_FORWARDABLE'
    | 'DEV_CI_NOT_GREEN'
    | 'CONTRADICTORY_EXISTING_TAG';
}

export function evaluateDevToMainPromotion(
  input: ReleasePromotionInput
): ReleasePromotionResult {
  if (!IMMUTABLE_SEMVER_TAG_PATTERN.test(input.semverTag)) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'INVALID_SEMVER_TAG',
    };
  }

  const immutableTagRef = `refs/tags/${input.semverTag}`;

  const promoteBoundary = verifyAppRoleBoundary({
    appRole: input.appRole,
    operation: 'promote_dev_to_main',
    targetRef: 'refs/heads/main',
    workflowPath: input.workflowPath,
    environmentName: input.environmentName,
    agentAppId: input.agentAppId,
    releaseAppId: input.releaseAppId,
  });

  const tagBoundary = verifyAppRoleBoundary({
    appRole: input.appRole,
    operation: 'create_release_tag',
    targetRef: immutableTagRef,
    workflowPath: input.workflowPath,
    environmentName: input.environmentName,
    agentAppId: input.agentAppId,
    releaseAppId: input.releaseAppId,
  });

  if (!promoteBoundary.allowed || !tagBoundary.allowed) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'UNAUTHORIZED_RELEASE_ACTOR',
    };
  }

  if (!input.releaseEnvironmentApproved) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'MISSING_RELEASE_ENVIRONMENT_APPROVAL',
    };
  }

  if (input.expectedDevSha !== input.currentDevSha) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'DEV_SHA_CHANGED',
    };
  }

  if (!input.isMainAncestorOfDev) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'MAIN_NOT_FAST_FORWARDABLE',
    };
  }

  if (!input.devRequiredCiGreen) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'DEV_CI_NOT_GREEN',
    };
  }

  if (
    input.existingTagTargetSha !== null &&
    input.existingTagTargetSha !== input.currentDevSha
  ) {
    return {
      allowed: false,
      promotedSha: null,
      fastForwardCommand: null,
      immutableTagRef: null,
      reasonCode: 'CONTRADICTORY_EXISTING_TAG',
    };
  }

  return {
    allowed: true,
    promotedSha: input.currentDevSha,
    fastForwardCommand: 'git push origin dev:main --ff-only',
    immutableTagRef,
    reasonCode: 'RELEASE_PROMOTED_FF_ONLY',
  };
}
