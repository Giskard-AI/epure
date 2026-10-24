import { describe, expect, it } from "vitest";
import {
  resumeOrPublishWithoutDuplicate,
  type ResumeOrPublishInput
} from "../src/execution/idempotent-resume-and-cancel.js";

describe("Ticket 23 (#24) — Idempotent orchestration resume without duplicate & cancellation fence", () => {
  it.each([
    {
      id: "reuses-existing-github-resource-when-state-write-was-interrupted",
      input: {
        idempotencyKey: "pr:task/24-resume->feature/1-epure-v1",
        planCancelled: false,
        ticketCancelled: false,
        existingGitHubResourceUrl: "https://github.com/Giskard-AI/epure/pull/42"
      } satisfies ResumeOrPublishInput,
      expectedPublished: true,
      expectedCreatedNewResource: false,
      expectedReusedExisting: true,
      expectedErrorCode: "NONE"
    },
    {
      id: "creates-resource-when-no-existing-resource-found-and-not-cancelled",
      input: {
        idempotencyKey: "pr:task/25-new->feature/1-epure-v1",
        planCancelled: false,
        ticketCancelled: false,
        existingGitHubResourceUrl: null
      } satisfies ResumeOrPublishInput,
      expectedPublished: true,
      expectedCreatedNewResource: true,
      expectedReusedExisting: false,
      expectedErrorCode: "NONE"
    },
    {
      id: "blocks-late-finishing-job-side-effects-when-plan-or-ticket-is-cancelled",
      input: {
        idempotencyKey: "pr:task/24-late->feature/1-epure-v1",
        planCancelled: true,
        ticketCancelled: false,
        existingGitHubResourceUrl: null
      } satisfies ResumeOrPublishInput,
      expectedPublished: false,
      expectedCreatedNewResource: false,
      expectedReusedExisting: false,
      expectedErrorCode: "CANCELLED_PLAN_BLOCKS_SIDE_EFFECTS"
    }
  ])(
    "resumeOrPublishWithoutDuplicate [$id]: prevents duplicate publications and enforces cancellation fence",
    async ({
      input,
      expectedPublished,
      expectedCreatedNewResource,
      expectedReusedExisting,
      expectedErrorCode
    }) => {
      const result = await resumeOrPublishWithoutDuplicate(input);
      expect(result.published).toBe(expectedPublished);
      expect(result.created_new_resource).toBe(expectedCreatedNewResource);
      expect(result.reused_existing_resource).toBe(expectedReusedExisting);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.existing_artifacts_preserved_for_audit).toBe(true);
    }
  );
});
