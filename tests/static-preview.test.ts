import { describe, expect, it } from "vitest";
import {
  evaluateStaticPreviewPublication,
  type StaticPreviewInput
} from "../src/frontend/static-preview.js";

describe("Ticket 33 (#34) — Publish and expire safe static HTML previews (GitHub Pages opt-in or existing host)", () => {
  it.each([
    {
      id: "falls-back-to-screenshots-and-artifacts-only-without-pages-opt-in",
      input: {
        githubPagesOptIn: false,
        existingExternalPreviewHostUrl: null,
        previewOrigin: "",
        productionOrigin: "https://app.giskard.ai",
        retentionDays: 14,
        bundleContainsSecretsOrPii: false
      } satisfies StaticPreviewInput,
      expectedMode: "artifacts_and_screenshots_only",
      expectedPublishedLiveUrl: false,
      expectedErrorCode: "NONE",
      expectedRetentionDays: 14
    },
    {
      id: "publishes-pages-preview-on-isolated-origin-with-14-day-default-expiration",
      input: {
        githubPagesOptIn: true,
        existingExternalPreviewHostUrl: null,
        previewOrigin: "https://giskard-ai.github.io/epure-previews/pr-34",
        productionOrigin: "https://app.giskard.ai",
        retentionDays: 0,
        bundleContainsSecretsOrPii: false
      } satisfies StaticPreviewInput,
      expectedMode: "github_pages_preview",
      expectedPublishedLiveUrl: true,
      expectedErrorCode: "NONE",
      expectedRetentionDays: 14
    },
    {
      id: "reuses-existing-external-preview-provider-without-requiring-github-pages",
      input: {
        githubPagesOptIn: false,
        existingExternalPreviewHostUrl: "https://preview-34.vercel.app",
        previewOrigin: "https://preview-34.vercel.app",
        productionOrigin: "https://app.giskard.ai",
        retentionDays: 14,
        bundleContainsSecretsOrPii: false
      } satisfies StaticPreviewInput,
      expectedMode: "external_preview_provider",
      expectedPublishedLiveUrl: true,
      expectedErrorCode: "NONE",
      expectedRetentionDays: 14
    },
    {
      id: "rejects-preview-sharing-production-origin-or-exposing-secrets",
      input: {
        githubPagesOptIn: true,
        existingExternalPreviewHostUrl: null,
        previewOrigin: "https://app.giskard.ai",
        productionOrigin: "https://app.giskard.ai",
        retentionDays: 14,
        bundleContainsSecretsOrPii: true
      } satisfies StaticPreviewInput,
      expectedMode: "rejected",
      expectedPublishedLiveUrl: false,
      expectedErrorCode: "UNSAFE_PREVIEW_ORIGIN_OR_SENSITIVE_DATA",
      expectedRetentionDays: 14
    }
  ])(
    "evaluateStaticPreviewPublication [$id]: enforces opt-in, origin isolation, secret check, and TTL",
    ({
      input,
      expectedMode,
      expectedPublishedLiveUrl,
      expectedErrorCode,
      expectedRetentionDays
    }) => {
      const result = evaluateStaticPreviewPublication(input);
      expect(result.delivery_mode).toBe(expectedMode);
      expect(result.live_preview_published).toBe(expectedPublishedLiveUrl);
      expect(result.error_code).toBe(expectedErrorCode);
      expect(result.retention_days).toBe(expectedRetentionDays);
    }
  );
});
