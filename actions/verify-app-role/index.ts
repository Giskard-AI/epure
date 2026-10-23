import { appendFileSync } from "node:fs";
import { verifyAppRoleBoundary } from "../../src/auth/github-apps.js";
import { redactSecrets } from "../../src/auth/issue-command-gate.js";

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
  if (!summaryPath || !markdown.trim()) {
    return;
  }
  appendFileSync(summaryPath, `${markdown}\n`, "utf8");
}

function run(): void {
  const appRole = process.env.INPUT_APP_ROLE ?? "";
  const operation = process.env.INPUT_OPERATION ?? "";
  const targetRef = process.env.INPUT_TARGET_REF ?? "";
  const workflowPath =
    process.env.INPUT_WORKFLOW_PATH ?? process.env.GITHUB_WORKFLOW_REF ?? "";
  const environmentName = process.env.INPUT_ENVIRONMENT_NAME ?? "";
  const agentAppId = process.env.INPUT_AGENT_APP_ID ?? "";
  const releaseAppId = process.env.INPUT_RELEASE_APP_ID ?? "";
  const humanConfirmed =
    (process.env.INPUT_HUMAN_CONFIRMED ?? "false").trim().toLowerCase() ===
    "true";
  const publicPayloadText = process.env.INPUT_PUBLIC_PAYLOAD_TEXT ?? "";

  const result = verifyAppRoleBoundary({
    appRole,
    operation,
    targetRef,
    workflowPath,
    environmentName,
    agentAppId,
    releaseAppId,
    humanConfirmed,
    publicPayloadText
  });

  writeGitHubOutputs({
    allowed: String(result.allowed),
    app_role: result.app_role,
    operation: result.operation,
    error_code: result.error_code,
    error_message: redactSecrets(result.error_message)
  });

  writeStepSummary(redactSecrets(result.summary_markdown));

  if (!result.allowed) {
    process.stderr.write(
      `::error title=EPURE App Role Violation (${result.error_code})::${redactSecrets(result.error_message)}\n`
    );
    process.exitCode = 1;
  }
}

run();
