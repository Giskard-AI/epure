export const EPURE_PUBLIC_VERSION = "1.0.0";

export type ContractErrorCode =
  | "NONE"
  | "INVALID_REPOSITORY_SLUG"
  | "MUTABLE_FLOATING_TAG_FORBIDDEN"
  | "INVALID_SHA_PINNING"
  | "SHARED_MAINTAINER_CREDENTIAL_FORBIDDEN";

export interface ContractVerificationInput {
  readonly repository: string;
  readonly pinnedRef: string;
  readonly strictShaPinning: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ContractVerificationResult {
  readonly status: "ok" | "error";
  readonly version: string;
  readonly contract_valid: "true" | "false";
  readonly error_code: ContractErrorCode;
  readonly error_message: string;
}

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FLOATING_TAG_PATTERN = /@v\d+(?:\.\d+)?(?:\s*(?:#.*)?)$/;
const IMMUTABLE_SEMVER_TAG_PATTERN =
  /^Giskard-AI\/epure\/[A-Za-z0-9_./-]+@v\d+\.\d+\.\d+(?:\s*(?:#.*)?)?$/;
const FULL_SHA_PIN_PATTERN =
  /^Giskard-AI\/epure\/[A-Za-z0-9_./-]+@[0-9a-f]{40}(?:\s+#\s*v\d+\.\d+\.\d+)?$/;

const FORBIDDEN_SHARED_ENV_KEYS = [
  "EPURE_MAINTAINER_SHARED_TOKEN",
  "EPURE_CENTRAL_RELAY_SECRET",
  "EPURE_SHARED_APP_PRIVATE_KEY"
] as const;

export function verifyPublicContract(
  input: ContractVerificationInput
): ContractVerificationResult {
  for (const key of FORBIDDEN_SHARED_ENV_KEYS) {
    const val = input.env[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return {
        status: "error",
        version: EPURE_PUBLIC_VERSION,
        contract_valid: "false",
        error_code: "SHARED_MAINTAINER_CREDENTIAL_FORBIDDEN",
        error_message: `Shared maintainer credential '${key}' is forbidden; consumer repositories must use their own isolated credentials.`
      };
    }
  }

  const repository = input.repository.trim();
  if (!REPO_SLUG_PATTERN.test(repository)) {
    return {
      status: "error",
      version: EPURE_PUBLIC_VERSION,
      contract_valid: "false",
      error_code: "INVALID_REPOSITORY_SLUG",
      error_message: `Invalid repository slug '${repository}'; expected '<owner>/<repo>'.`
    };
  }

  const pinnedRef = input.pinnedRef.trim();
  if (FLOATING_TAG_PATTERN.test(pinnedRef)) {
    return {
      status: "error",
      version: EPURE_PUBLIC_VERSION,
      contract_valid: "false",
      error_code: "MUTABLE_FLOATING_TAG_FORBIDDEN",
      error_message: `Floating tag reference '${pinnedRef}' is forbidden by ADR-0025; pin a 40-char Git SHA or immutable vMAJOR.MINOR.PATCH tag.`
    };
  }

  if (input.strictShaPinning) {
    if (!FULL_SHA_PIN_PATTERN.test(pinnedRef)) {
      return {
        status: "error",
        version: EPURE_PUBLIC_VERSION,
        contract_valid: "false",
        error_code: "INVALID_SHA_PINNING",
        error_message: `Reference '${pinnedRef}' must be pinned to a full 40-character Git SHA under Giskard-AI/epure.`
      };
    }
  } else if (
    !FULL_SHA_PIN_PATTERN.test(pinnedRef) &&
    !IMMUTABLE_SEMVER_TAG_PATTERN.test(pinnedRef)
  ) {
    return {
      status: "error",
      version: EPURE_PUBLIC_VERSION,
      contract_valid: "false",
      error_code: "INVALID_SHA_PINNING",
      error_message: `Reference '${pinnedRef}' must target Giskard-AI/epure with a 40-char SHA or immutable SemVer tag vMAJOR.MINOR.PATCH.`
    };
  }

  return {
    status: "ok",
    version: EPURE_PUBLIC_VERSION,
    contract_valid: "true",
    error_code: "NONE",
    error_message: ""
  };
}
