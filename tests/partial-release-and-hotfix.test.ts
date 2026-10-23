import { describe, expect, it } from 'vitest';
import {
  planHotfixReintegrationIntoDev,
  planPartialReleaseRecovery,
} from '../src/release/partial-release-and-hotfix.js';

describe('Partial release idempotent resume & hotfix reintegration (Ticket 37 / Issue #38)', () => {
  it.each([
    {
      scenario: 'recreates only the missing GitHub Release when tag already exists at promoted main SHA',
      state: {
        semverTag: 'v1.0.0',
        promotedMainSha: 'sha-main-100',
        existingTagTargetSha: 'sha-main-100',
        githubReleasePublished: false,
      },
      expectedAllowed: true,
      expectedSteps: ['PUBLISH_GITHUB_RELEASE'],
      expectedReason: 'RESUME_MISSING_RELEASE_OBJECTS',
    },
    {
      scenario: 'creates both immutable tag and GitHub Release when fast-forward succeeded before tag creation',
      state: {
        semverTag: 'v1.0.0',
        promotedMainSha: 'sha-main-100',
        existingTagTargetSha: null,
        githubReleasePublished: false,
      },
      expectedAllowed: true,
      expectedSteps: ['CREATE_IMMUTABLE_TAG', 'PUBLISH_GITHUB_RELEASE'],
      expectedReason: 'RESUME_MISSING_RELEASE_OBJECTS',
    },
    {
      scenario: 'blocks recovery when existing SemVer tag points to a different SHA',
      state: {
        semverTag: 'v1.0.0',
        promotedMainSha: 'sha-main-100',
        existingTagTargetSha: 'sha-other-999',
        githubReleasePublished: false,
      },
      expectedAllowed: false,
      expectedSteps: [],
      expectedReason: 'TAG_CONFLICT_DIFFERENT_SHA',
    },
  ])('$scenario', ({ state, expectedAllowed, expectedSteps, expectedReason }) => {
    const res = planPartialReleaseRecovery(state);
    expect(res.allowed).toBe(expectedAllowed);
    expect(res.stepsToExecute).toEqual(expectedSteps);
    expect(res.reasonCode).toBe(expectedReason);
  });

  it.each([
    {
      scenario: 'fast-forwards dev to main when hotfix was applied on main and dev had no new commits',
      input: {
        mainSha: 'sha-hotfix',
        devSha: 'sha-prev-release',
        isMainAncestorOfDev: false,
        isDevAncestorOfMain: true,
      },
      expectedRequires: true,
      expectedStrategy: 'FAST_FORWARD_DEV_TO_MAIN',
    },
    {
      scenario: 'merges main into dev via true merge commit when both main (hotfix) and dev have new commits, preserving main ancestry for next fast-forward release',
      input: {
        mainSha: 'sha-hotfix',
        devSha: 'sha-dev-next',
        isMainAncestorOfDev: false,
        isDevAncestorOfMain: false,
      },
      expectedRequires: true,
      expectedStrategy: 'MERGE_MAIN_INTO_DEV_PR',
    },
  ])('$scenario', ({ input, expectedRequires, expectedStrategy }) => {
    const res = planHotfixReintegrationIntoDev(input);
    expect(res.requiresReintegration).toBe(expectedRequires);
    expect(res.strategy).toBe(expectedStrategy);
    expect(res.preservesMainAncestryForNextRelease).toBe(true);
  });
});
