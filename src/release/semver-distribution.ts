import { IMMUTABLE_SEMVER_TAG_PATTERN } from './promote-dev-to-main.js';

export interface PublicInterfaceContract {
  workflowOrActionPath: string;
  requiredInputs: string[];
  outputs: string[];
}

export interface SemverReleaseValidationInput {
  previousVersion: string;
  nextVersion: string;
  floatingTagsRequested: string[];
  previousContracts: PublicInterfaceContract[];
  nextContracts: PublicInterfaceContract[];
  changelogMarkdown: string;
  thirdPartyAttributionsPresent: boolean;
}

export interface SemverReleaseValidationResult {
  valid: boolean;
  breakingChanges: string[];
  reasonCode:
    | 'VALID_IMMUTABLE_SEMVER_RELEASE'
    | 'INVALID_SEMVER_TAG'
    | 'FLOATING_TAG_FORBIDDEN'
    | 'BREAKING_CHANGE_WITHOUT_MAJOR_BUMP'
    | 'MISSING_CHANGELOG_OR_ATTRIBUTIONS';
}

function parseMajorVersion(tag: string): number | null {
  const m = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!m || !m[1]) return null;
  return Number.parseInt(m[1], 10);
}

export function validateSemverReleaseAndCompatibility(
  input: SemverReleaseValidationInput
): SemverReleaseValidationResult {
  if (input.floatingTagsRequested.length > 0) {
    return {
      valid: false,
      breakingChanges: [],
      reasonCode: 'FLOATING_TAG_FORBIDDEN',
    };
  }

  if (
    !IMMUTABLE_SEMVER_TAG_PATTERN.test(input.previousVersion) ||
    !IMMUTABLE_SEMVER_TAG_PATTERN.test(input.nextVersion)
  ) {
    return {
      valid: false,
      breakingChanges: [],
      reasonCode: 'INVALID_SEMVER_TAG',
    };
  }

  if (!input.changelogMarkdown.trim() || !input.thirdPartyAttributionsPresent) {
    return {
      valid: false,
      breakingChanges: [],
      reasonCode: 'MISSING_CHANGELOG_OR_ATTRIBUTIONS',
    };
  }

  const breakingChanges: string[] = [];
  const nextByPath = new Map(
    input.nextContracts.map((c) => [c.workflowOrActionPath, c])
  );

  for (const prev of input.previousContracts) {
    const next = nextByPath.get(prev.workflowOrActionPath);
    if (!next) {
      breakingChanges.push(`Removed entrypoint ${prev.workflowOrActionPath}`);
      continue;
    }
    const prevRequired = new Set(prev.requiredInputs);
    for (const req of next.requiredInputs) {
      if (!prevRequired.has(req)) {
        breakingChanges.push(
          `Added new required input '${req}' on ${prev.workflowOrActionPath}`
        );
      }
    }
    const nextOutputs = new Set(next.outputs);
    for (const out of prev.outputs) {
      if (!nextOutputs.has(out)) {
        breakingChanges.push(`Removed output '${out}' on ${prev.workflowOrActionPath}`);
      }
    }
  }

  const prevMajor = parseMajorVersion(input.previousVersion) ?? 0;
  const nextMajor = parseMajorVersion(input.nextVersion) ?? 0;

  if (breakingChanges.length > 0 && nextMajor <= prevMajor) {
    return {
      valid: false,
      breakingChanges,
      reasonCode: 'BREAKING_CHANGE_WITHOUT_MAJOR_BUMP',
    };
  }

  return {
    valid: true,
    breakingChanges,
    reasonCode: 'VALID_IMMUTABLE_SEMVER_RELEASE',
  };
}

export interface ConsumerUpgradeProposalInput {
  consumerWorkflowContent: string;
  previousSha: string;
  previousTag: string;
  nextSha: string;
  nextTag: string;
}

export interface ConsumerUpgradeProposalResult {
  updatedWorkflowContent: string;
  updatedPinCount: number;
  keepsPreviousShaUntilMerged: true;
}

export function proposeConsumerShaUpgrade(
  input: ConsumerUpgradeProposalInput
): ConsumerUpgradeProposalResult {
  const escapedPrevSha = input.previousSha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPrevTag = input.previousTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(Giskard-AI/epure/[A-Za-z0-9._/-]+@)${escapedPrevSha}(\\s+#\\s*)${escapedPrevTag}`,
    'g'
  );

  let updatedPinCount = 0;
  const updatedWorkflowContent = input.consumerWorkflowContent.replace(
    pattern,
    (_match, prefix: string, sep: string) => {
      updatedPinCount += 1;
      return `${prefix}${input.nextSha}${sep}${input.nextTag}`;
    }
  );

  return {
    updatedWorkflowContent,
    updatedPinCount,
    keepsPreviousShaUntilMerged: true,
  };
}
