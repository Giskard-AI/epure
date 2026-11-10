// actions/epure-contract/index.ts
import { appendFileSync } from "node:fs";

// package.json
var package_default = {
  name: "@giskard-ai/epure",
  version: "3.0.0",
  private: true,
  description: "EPURE (Giskard-AI/epure) \u2014 Public Reusable Workflows, TypeScript Custom Actions (Node.js 24 LTS), and Agent Skills",
  license: "Apache-2.0",
  type: "module",
  engines: {
    node: ">=24.0.0"
  },
  bin: {
    "epure-setup-repo": "./dist/cli/setup-repo.mjs"
  },
  scripts: {
    build: "node scripts/build-actions.mjs",
    typecheck: "tsc --noEmit",
    test: "vitest run --exclude 'tests/live/**' --exclude 'tests/live-github/**' --exclude 'tests/e2e/**'",
    "test:live": "vitest run tests/live/",
    "test:live:github": "EPURE_LIVE_GITHUB=1 vitest run tests/live-github/",
    "test:e2e": "EPURE_E2E=run vitest run tests/e2e/sandbox-epic.e2e.test.ts",
    "test:e2e:reset": "EPURE_E2E=reset vitest run tests/e2e/sandbox-epic.e2e.test.ts",
    "docs:diagrams": "node scripts/build-diagrams.mjs",
    "docs:llms": "node scripts/build-llms-txt.mjs",
    "docs:dev": "vitepress dev docs",
    "docs:build": "node scripts/build-llms-txt.mjs && vitepress build docs",
    "docs:preview": "vitepress preview docs"
  },
  devDependencies: {
    "@cursor/sdk": "1.3.1",
    "@earendil-works/pi-coding-agent": "1.5.0",
    "@types/node": "24.19.2",
    esbuild: "0.28.2",
    typescript: "7.0.2",
    vitepress: "1.6.4",
    vitest: "5.0.5"
  }
};

// src/contract/epure-contract.ts
var EPURE_PUBLIC_VERSION = package_default.version;
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
      error_message: `Floating tag reference '${pinnedRef}' is forbidden (https://giskard-ai.github.io/epure/architecture); pin a 40-char Git SHA or immutable vMAJOR.MINOR.PATCH tag.`
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
