import { appendFileSync } from "node:fs";
import {
  evaluateIssueCommandGate,
  fetchEffectiveRepositoryPermission,
  redactSecrets
} from "../../src/auth/issue-command-gate.js";

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

async function run(): Promise<void> {
  const repository =
    process.env.INPUT_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const issueNumberRaw = process.env.INPUT_ISSUE_NUMBER ?? "0";
  const issueNumber = Number.parseInt(issueNumberRaw, 10) || 0;
  const commentBody = process.env.INPUT_COMMENT_BODY ?? "";
  const actorLogin = process.env.INPUT_ACTOR ?? process.env.GITHUB_ACTOR ?? "";
  const actorType = process.env.INPUT_ACTOR_TYPE ?? "User";
  const authorAssociation = process.env.INPUT_AUTHOR_ASSOCIATION ?? "NONE";
  const issueLabelsRaw = process.env.INPUT_ISSUE_LABELS ?? "";
  const issueLabels = issueLabelsRaw
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const preFetchedPermission = (
    process.env.INPUT_EFFECTIVE_PERMISSION ?? ""
  ).trim();
  const githubToken = (
    process.env.INPUT_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    ""
  ).trim();

  const secretsToRedact = [githubToken].filter((val) => val.length > 0);

  const result = await evaluateIssueCommandGate({
    repository,
    issueNumber,
    commentBody,
    actor: {
      login: actorLogin,
      type: actorType
    },
    authorAssociation,
    issueLabels,
    effectivePermission: preFetchedPermission
      ? { permission: preFetchedPermission, role_name: preFetchedPermission }
      : undefined,
    verifyPermission:
      !preFetchedPermission && githubToken
        ? (repo, username) =>
            fetchEffectiveRepositoryPermission({
              repository: repo,
              username,
              githubToken
            })
        : undefined,
    secretsToRedact
  });

  writeGitHubOutputs({
    authorized: String(result.authorized),
    decision: result.decision,
    command: result.command ?? "",
    command_args: result.command_args,
    effective_permission: result.effective_permission,
    privileged_action_allowed: String(result.privileged_action_allowed),
    llm_call_allowed: String(result.llm_call_allowed),
    should_post_response: String(result.should_post_response),
    error_code: result.error_code,
    error_message: result.error_message,
    response_markdown: result.response_markdown
  });

  if (result.response_markdown) {
    writeStepSummary(redactSecrets(result.response_markdown, secretsToRedact));
  }

  if (
    result.decision === "denied_insufficient_permission" ||
    result.decision === "denied_unsupported_command" ||
    result.decision === "denied_invalid_repository"
  ) {
    process.stderr.write(
      `::error title=EPURE Command Denied (${result.error_code})::${result.error_message}\n`
    );
    process.exitCode = 1;
  }
}

void run();
