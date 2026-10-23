import { describe, expect, it } from 'vitest';
import {
  proposeConsumerShaUpgrade,
  validateSemverReleaseAndCompatibility,
} from '../src/release/semver-distribution.js';

describe('Immutable SemVer distribution & consumer SHA upgrade (Ticket 38 / Issue #39)', () => {
  it.each([
    {
      scenario: 'accepts backward-compatible minor release with immutable vMAJOR.MINOR.PATCH tag, changelog, and attributions',
      input: {
        previousVersion: 'v1.0.0',
        nextVersion: 'v1.1.0',
        floatingTagsRequested: [],
        previousContracts: [
          {
            workflowOrActionPath: 'actions/epure-contract',
            requiredInputs: ['consumer_repo'],
            outputs: ['contract_version', 'verified'],
          },
        ],
        nextContracts: [
          {
            workflowOrActionPath: 'actions/epure-contract',
            requiredInputs: ['consumer_repo'],
            outputs: ['contract_version', 'verified', 'summary_markdown'],
          },
        ],
        changelogMarkdown: '## v1.1.0\n- Added summary_markdown output',
        thirdPartyAttributionsPresent: true,
      },
      expectedValid: true,
      expectedReason: 'VALID_IMMUTABLE_SEMVER_RELEASE',
    },
    {
      scenario: 'forbids any floating major tag such as v1 per ADR-0025',
      input: {
        previousVersion: 'v1.0.0',
        nextVersion: 'v1.1.0',
        floatingTagsRequested: ['v1'],
        previousContracts: [],
        nextContracts: [],
        changelogMarkdown: '## v1.1.0',
        thirdPartyAttributionsPresent: true,
      },
      expectedValid: false,
      expectedReason: 'FLOATING_TAG_FORBIDDEN',
    },
    {
      scenario: 'rejects incompatible interface change in a minor bump without a major version increment',
      input: {
        previousVersion: 'v1.0.0',
        nextVersion: 'v1.1.0',
        floatingTagsRequested: [],
        previousContracts: [
          {
            workflowOrActionPath: 'actions/epure-contract',
            requiredInputs: ['consumer_repo'],
            outputs: ['contract_version', 'verified'],
          },
        ],
        nextContracts: [
          {
            workflowOrActionPath: 'actions/epure-contract',
            requiredInputs: ['consumer_repo', 'new_mandatory_input'],
            outputs: ['contract_version'],
          },
        ],
        changelogMarkdown: '## v1.1.0',
        thirdPartyAttributionsPresent: true,
      },
      expectedValid: false,
      expectedReason: 'BREAKING_CHANGE_WITHOUT_MAJOR_BUMP',
    },
    {
      scenario: 'allows incompatible interface change when bumping major SemVer version (v1.0.0 -> v2.0.0)',
      input: {
        previousVersion: 'v1.0.0',
        nextVersion: 'v2.0.0',
        floatingTagsRequested: [],
        previousContracts: [
          {
            workflowOrActionPath: 'actions/epure-contract',
            requiredInputs: ['consumer_repo'],
            outputs: ['contract_version', 'verified'],
          },
        ],
        nextContracts: [
          {
            workflowOrActionPath: 'actions/epure-contract',
            requiredInputs: ['consumer_repo', 'new_mandatory_input'],
            outputs: ['contract_version'],
          },
        ],
        changelogMarkdown: '## v2.0.0\n- Breaking interface update',
        thirdPartyAttributionsPresent: true,
      },
      expectedValid: true,
      expectedReason: 'VALID_IMMUTABLE_SEMVER_RELEASE',
    },
  ])('$scenario', ({ input, expectedValid, expectedReason }) => {
    const res = validateSemverReleaseAndCompatibility(input);
    expect(res.valid).toBe(expectedValid);
    expect(res.reasonCode).toBe(expectedReason);
  });

  it('proposes Renovate SHA + immutable SemVer comment upgrade for consumer repository while keeping previous SHA until merged', () => {
    const consumerWorkflow = [
      'jobs:',
      '  epure:',
      '    uses: Giskard-AI/epure/.github/workflows/epure-check.yml@1111111111111111111111111111111111111111 # v1.0.0',
    ].join('\n');

    const res = proposeConsumerShaUpgrade({
      consumerWorkflowContent: consumerWorkflow,
      previousSha: '1111111111111111111111111111111111111111',
      previousTag: 'v1.0.0',
      nextSha: '2222222222222222222222222222222222222222',
      nextTag: 'v1.1.0',
    });

    expect(res.updatedPinCount).toBe(1);
    expect(res.keepsPreviousShaUntilMerged).toBe(true);
    expect(res.updatedWorkflowContent).toContain(
      'Giskard-AI/epure/.github/workflows/epure-check.yml@2222222222222222222222222222222222222222 # v1.1.0'
    );
  });
});
