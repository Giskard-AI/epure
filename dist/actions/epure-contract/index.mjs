// actions/epure-contract/index.ts
import { appendFileSync } from "node:fs";

// src/contract/epure-contract.ts
var EPURE_PUBLIC_VERSION = "1.0.0";
var REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var FLOATING_TAG_PATTERN = /@v\d+(?:\.\d+)?(?:\s*(?:#.*)?)$/;
var IMMUTABLE_SEMVER_TAG_PATTERN = /^Giskard-AI\/epure\/[A-Za-z0-9_./-]+@v\d+\.\d+\.\d+(?:\s*(?:#.*)?)?$/;
var FULL_SHA_PIN_PATTERN = /^Giskard-AI\/epure\/[A-Za-z0-9_./-]+@[0-9a-f]{40}(?:\s+#\s*v\d+\.\d+\.\d+)?$/;
var FORBIDDEN_SHARED_ENV_KEYS = [
  "EPURE_MAINTAINER_SHARED_TOKEN",
  "EPURE_CENTRAL_RELAY_SECRET",
  "EPURE_SHARED_APP_PRIVATE_KEY"
];
function verifyPublicContract(input) {
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
  } else if (!FULL_SHA_PIN_PATTERN.test(pinnedRef) && !IMMUTABLE_SEMVER_TAG_PATTERN.test(pinnedRef)) {
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

// actions/epure-contract/index.ts
function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value.replace(/\r?\n/g, " ")}`).join("\n");
  appendFileSync(outputPath, `${lines}
`, "utf8");
}
function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  appendFileSync(summaryPath, `${markdown}
`, "utf8");
}
function run() {
  const repository = process.env.INPUT_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const pinnedRef = process.env.INPUT_PINNED_REF ?? "";
  const strictRaw = (process.env.INPUT_STRICT_SHA_PINNING ?? "true").trim().toLowerCase();
  const strictShaPinning = strictRaw !== "false";
  const result = verifyPublicContract({
    repository,
    pinnedRef,
    strictShaPinning,
    env: process.env
  });
  writeGitHubOutputs({
    status: result.status,
    version: result.version,
    contract_valid: result.contract_valid,
    error_code: result.error_code,
    error_message: result.error_message
  });
  writeStepSummary(
    [
      "### EPURE Public Contract Check",
      `- **Repository**: \`${repository}\``,
      `- **Status**: \`${result.status}\``,
      `- **Version**: \`${result.version}\``,
      `- **Contract Valid**: \`${result.contract_valid}\``,
      `- **Error Code**: \`${result.error_code}\``
    ].join("\n")
  );
  if (result.status !== "ok") {
    process.stderr.write(
      `::error title=EPURE Contract Error (${result.error_code})::${result.error_message}
`
    );
    process.exitCode = 1;
  }
}
run();
