import { appendFileSync } from "node:fs";
import { runTicketWithHarness } from "../../src/harness/agent-harness.js";

function writeActionOutputs(outputs: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
  }
}

async function main(): Promise<void> {
  const harness = process.env.INPUT_HARNESS ?? "pi";
  const repository = process.env.INPUT_REPOSITORY ?? "";
  const repositoryId = Number(process.env.INPUT_REPOSITORY_ID ?? "0");
  const planIssueNumber = Number(process.env.INPUT_PLAN_ISSUE_NUMBER ?? "1");
  const ticketIssueNumber = Number(process.env.INPUT_TICKET_ISSUE_NUMBER ?? "0");
  const ticketSlug = process.env.INPUT_TICKET_SLUG ?? "ticket";
  const ticketTitle = process.env.INPUT_TICKET_TITLE ?? "Implement ticket";
  const targetFeatureBranch =
    process.env.INPUT_TARGET_FEATURE_BRANCH ?? "feature/1-epure";
  const approvedByHuman =
    (process.env.INPUT_APPROVED_BY_HUMAN ?? "true").toLowerCase() === "true";

  let changedFiles = ["src/index.ts"];
  try {
    const parsed: unknown = JSON.parse(
      process.env.INPUT_CHANGED_FILES_JSON ?? '["src/index.ts"]'
    );
    if (Array.isArray(parsed)) {
      changedFiles = parsed.filter((f): f is string => typeof f === "string");
    }
  } catch {
    changedFiles = ["src/index.ts"];
  }

  const result = await runTicketWithHarness({
    harness,
    repository,
    repositoryId,
    planIssueNumber,
    ticketIssueNumber,
    ticketSlug,
    ticketTitle,
    acceptanceCriteria: ["Passes automated tests"],
    approvedByHuman,
    targetFeatureBranch,
    changedFiles,
    isolationAvailable: true,
    runnerEnv: process.env
  });

  writeActionOutputs({
    completed: String(result.completed),
    error_code: result.error_code,
    harness: result.harness,
    task_branch: result.task_branch,
    pull_request_url: result.pull_request_url
  });

  if (!result.completed) {
    process.stderr.write(`${result.error_code}: ${result.error_message}\n`);
    process.exitCode = 1;
  }
}

await main();
