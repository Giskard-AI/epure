import { appendFileSync } from "node:fs";
import { verifyPublicContract } from "../../src/contract/epure-contract.js";

function writeGitHubOutputs(outputs: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, " ")}`)
    .join("\n");
  appendFileSync(outputPath, `${lines}\n`, "utf8");
}

function writeStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  appendFileSync(summaryPath, `${markdown}\n`, "utf8");
}

function run(): void {
  const repository =
    process.env.INPUT_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const pinnedRef = process.env.INPUT_PINNED_REF ?? "";
  const strictRaw = (process.env.INPUT_STRICT_SHA_PINNING ?? "true")
    .trim()
    .toLowerCase();
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
      `::error title=EPURE Contract Error (${result.error_code})::${result.error_message}\n`
    );
    process.exitCode = 1;
  }
}

run();
