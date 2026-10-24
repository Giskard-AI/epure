export type StaticPreviewDeliveryMode =
  | "artifacts_and_screenshots_only"
  | "github_pages_preview"
  | "external_preview_provider"
  | "rejected";

export type StaticPreviewErrorCode =
  | "NONE"
  | "UNSAFE_PREVIEW_ORIGIN_OR_SENSITIVE_DATA";

export interface StaticPreviewInput {
  readonly githubPagesOptIn: boolean;
  readonly existingExternalPreviewHostUrl: string | null;
  readonly previewOrigin: string;
  readonly productionOrigin: string;
  readonly retentionDays: number;
  readonly bundleContainsSecretsOrPii: boolean;
}

export interface StaticPreviewResult {
  readonly delivery_mode: StaticPreviewDeliveryMode;
  readonly live_preview_published: boolean;
  readonly preview_url: string;
  readonly retention_days: number;
  readonly error_code: StaticPreviewErrorCode;
  readonly error_message: string;
}

export function evaluateStaticPreviewPublication(
  input: StaticPreviewInput
): StaticPreviewResult {
  const retentionDays =
    input.retentionDays > 0 && input.retentionDays <= 90
      ? input.retentionDays
      : 14;

  const hasLiveRequest =
    input.githubPagesOptIn ||
    (typeof input.existingExternalPreviewHostUrl === "string" &&
      input.existingExternalPreviewHostUrl.trim().length > 0);

  if (!hasLiveRequest) {
    return {
      delivery_mode: "artifacts_and_screenshots_only",
      live_preview_published: false,
      preview_url: "",
      retention_days: retentionDays,
      error_code: "NONE",
      error_message: ""
    };
  }

  const cleanPreviewOrigin = input.previewOrigin.trim().toLowerCase();
  const cleanProdOrigin = input.productionOrigin.trim().toLowerCase();

  if (
    input.bundleContainsSecretsOrPii ||
    !cleanPreviewOrigin ||
    cleanPreviewOrigin === cleanProdOrigin
  ) {
    return {
      delivery_mode: "rejected",
      live_preview_published: false,
      preview_url: "",
      retention_days: retentionDays,
      error_code: "UNSAFE_PREVIEW_ORIGIN_OR_SENSITIVE_DATA",
      error_message:
        "Preview publication refused: preview must use an origin isolated from production and must not expose secrets or sensitive data (ADR-0022)."
    };
  }

  if (
    typeof input.existingExternalPreviewHostUrl === "string" &&
    input.existingExternalPreviewHostUrl.trim().length > 0
  ) {
    return {
      delivery_mode: "external_preview_provider",
      live_preview_published: true,
      preview_url: input.existingExternalPreviewHostUrl.trim(),
      retention_days: retentionDays,
      error_code: "NONE",
      error_message: ""
    };
  }

  return {
    delivery_mode: "github_pages_preview",
    live_preview_published: true,
    preview_url: input.previewOrigin.trim(),
    retention_days: retentionDays,
    error_code: "NONE",
    error_message: ""
  };
}
