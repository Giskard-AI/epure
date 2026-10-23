export interface PartialReleaseState {
  semverTag: string;
  promotedMainSha: string;
  existingTagTargetSha: string | null;
  githubReleasePublished: boolean;
}

export interface PartialReleaseRecoveryPlan {
  allowed: boolean;
  stepsToExecute: Array<'CREATE_IMMUTABLE_TAG' | 'PUBLISH_GITHUB_RELEASE'>;
  reasonCode:
    | 'RESUME_MISSING_RELEASE_OBJECTS'
    | 'RELEASE_ALREADY_COMPLETE'
    | 'TAG_CONFLICT_DIFFERENT_SHA';
}

export function planPartialReleaseRecovery(
  state: PartialReleaseState
): PartialReleaseRecoveryPlan {
  if (
    state.existingTagTargetSha !== null &&
    state.existingTagTargetSha !== state.promotedMainSha
  ) {
    return {
      allowed: false,
      stepsToExecute: [],
      reasonCode: 'TAG_CONFLICT_DIFFERENT_SHA',
    };
  }

  const stepsToExecute: Array<'CREATE_IMMUTABLE_TAG' | 'PUBLISH_GITHUB_RELEASE'> = [];
  if (state.existingTagTargetSha === null) {
    stepsToExecute.push('CREATE_IMMUTABLE_TAG');
  }
  if (!state.githubReleasePublished) {
    stepsToExecute.push('PUBLISH_GITHUB_RELEASE');
  }

  if (stepsToExecute.length === 0) {
    return {
      allowed: true,
      stepsToExecute: [],
      reasonCode: 'RELEASE_ALREADY_COMPLETE',
    };
  }

  return {
    allowed: true,
    stepsToExecute,
    reasonCode: 'RESUME_MISSING_RELEASE_OBJECTS',
  };
}

export interface HotfixReintegrationInput {
  mainSha: string;
  devSha: string;
  isMainAncestorOfDev: boolean;
  isDevAncestorOfMain: boolean;
}

export interface HotfixReintegrationPlan {
  requiresReintegration: boolean;
  strategy: 'NONE_NEEDED' | 'FAST_FORWARD_DEV_TO_MAIN' | 'MERGE_MAIN_INTO_DEV_PR';
  commands: string[];
  preservesMainAncestryForNextRelease: boolean;
}

export function planHotfixReintegrationIntoDev(
  input: HotfixReintegrationInput
): HotfixReintegrationPlan {
  if (input.isMainAncestorOfDev) {
    return {
      requiresReintegration: false,
      strategy: 'NONE_NEEDED',
      commands: [],
      preservesMainAncestryForNextRelease: true,
    };
  }

  if (input.isDevAncestorOfMain) {
    return {
      requiresReintegration: true,
      strategy: 'FAST_FORWARD_DEV_TO_MAIN',
      commands: ['git checkout dev', 'git merge --ff-only origin/main', 'git push origin dev'],
      preservesMainAncestryForNextRelease: true,
    };
  }

  return {
    requiresReintegration: true,
    strategy: 'MERGE_MAIN_INTO_DEV_PR',
    commands: [
      'git checkout -b task/reintegrate-main-hotfix origin/dev',
      'git merge --no-ff origin/main -m "chore(release): reintegrate main hotfix into dev"',
      'git push -u origin task/reintegrate-main-hotfix',
    ],
    preservesMainAncestryForNextRelease: true,
  };
}
