import type { GitHubRestHelper, WorkflowJobRef } from "./types.js";

// GitHub's default `timeout-minutes`, and the most a GitHub-hosted runner lets a job run.
export const GITHUB_MAX_JOB_TIMEOUT_MINUTES = 360;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The `timeout-minutes` literal of a job; undefined when the job sets none or uses an expression. */
export function parseJobTimeoutMinutes(
  workflowYaml: string,
  jobId: string
): number | undefined {
  const lines = workflowYaml.split(/\r?\n/);
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\s+${escapedJobId}:\\s*(#.*)?$`);
  const jobsLine = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (jobsLine < 0) {
    return undefined;
  }
  // Only a direct child of the top-level `jobs:` is a job header.
  let header = -1;
  let jobIndent: number | undefined;
  for (let i = jobsLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#.*)?$/.test(line)) {
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) {
      break;
    }
    jobIndent ??= indent;
    if (indent === jobIndent && headerPattern.test(line)) {
      header = i;
      break;
    }
  }
  if (header < 0) {
    return undefined;
  }
  const headerIndent = indentOf(lines[header]!);
  let keyIndent: number | undefined;
  for (const line of lines.slice(header + 1)) {
    if (/^\s*(#.*)?$/.test(line)) {
      continue;
    }
    const indent = indentOf(line);
    if (indent <= headerIndent) {
      return undefined;
    }
    keyIndent ??= indent;
    if (indent !== keyIndent || !/^\s*timeout-minutes:/.test(line)) {
      continue;
    }
    const minutes = Number(
      /^\s*timeout-minutes:\s*["']?(\d+)["']?\s*(#.*)?$/.exec(line)?.[1]
    );
    return minutes > 0 ? minutes : undefined;
  }
  return undefined;
}

/**
 * The timeout GitHub enforces on the running job, read from the workflow file it runs from.
 * A missing or unresolvable value maps to the 360-minute default and hosted-runner maximum.
 */
export async function resolveJobTimeoutMinutes(
  gh: Pick<GitHubRestHelper, "readSingleBranchFile">,
  job: WorkflowJobRef
): Promise<number> {
  const workflowYaml = await gh.readSingleBranchFile(job.ref, job.path);
  return (
    (workflowYaml === null
      ? undefined
      : parseJobTimeoutMinutes(workflowYaml, job.jobId)) ??
    GITHUB_MAX_JOB_TIMEOUT_MINUTES
  );
}
