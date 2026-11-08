import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LLMTokenUsage } from "../../src/llm/usage.js";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  readRunLease,
  type EpureIssueState
} from "../../src/state/git-ref-state.js";
import type { E2eConfig } from "./config.js";
import { EPIC_BODY, EPIC_TITLE, GRILL_ANSWERS } from "./epic.js";
import type { GitHubApi } from "./github.js";
import {
  decideEscalation,
  escalationReasonFromComment,
  evaluateRun,
  parseUsageLines,
  PhaseClock,
  renderMarkdownReport,
  summarizeUsage,
  type E2eRunResult,
  type EscalationEvent,
  type PullRequestRef
} from "./report.js";
import { commitFiles, forceBranches, readTreeFiles, resetSandbox, SEED_DIR } from "./reset.js";

const EPURE_REPOSITORY = "Giskard-AI/epure";
const ISSUE_COMMAND_WORKFLOW = ".github/workflows/epure-issue-command.yml";
const POLL_MS = 30_000;
// Polls with nothing running and the plan still active before the harness calls it stalled.
const STALL_POLLS = 6;
const AGENT_SECRETS = ["EPURE_AGENT_APP_ID", "EPURE_AGENT_APP_PRIVATE_KEY", "LLM_API_KEY"];

export type StepProgress = "pending" | "settled" | "suspended" | "done";

// A step is over once EPURE has processed the comment, nothing runs in the sandbox and no run holds the plan.
export function stepProgress(
  state: EpureIssueState | null,
  since: { readonly commentId: number; readonly version: number },
  activeRuns: number,
  nowMs: number
): StepProgress {
  if (!state || (state.last_processed_comment_id < since.commentId && state.version <= since.version)) {
    return "pending";
  }
  const lease = readRunLease(state, nowMs);
  if (activeRuns > 0 || (lease && !lease.stale)) {
    return "pending";
  }
  if (state.status === "suspended") {
    return "suspended";
  }
  return state.status === "done" ? "done" : "settled";
}

interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}

interface Run {
  readonly config: E2eConfig;
  readonly gh: GitHubApi;
  readonly log: (line: string) => void;
  readonly startedAt: string;
  readonly escalations: EscalationEvent[];
  issue: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listRunsSince(run: Run): Promise<WorkflowRun[]> {
  return run.gh.paginate<WorkflowRun>(
    `/repos/${run.gh.repository}/actions/runs?created=${encodeURIComponent(`>=${run.startedAt}`)}`,
    (page) => (page as { workflow_runs: WorkflowRun[] }).workflow_runs
  );
}

async function readState(run: Run, token: string): Promise<EpureIssueState | null> {
  const store = createGitHubApiRefStateStore({ repository: run.gh.repository, githubToken: token });
  return (await store.readRef(buildIssueStateRefName(run.issue))).state;
}

async function postComment(run: Run, body: string): Promise<number> {
  const comment = await run.gh.call<{ id: number }>("POST", `/repos/${run.gh.repository}/issues/${run.issue}/comments`, { body });
  run.log(`[epic] #${run.issue} <- ${body.split("\n")[0]!.slice(0, 80)}`);
  return comment.id;
}

async function latestEscalationReason(run: Run): Promise<string | null> {
  const comments = await run.gh.paginate<{ body: string }>(`/repos/${run.gh.repository}/issues/${run.issue}/comments`);
  for (const c of comments.reverse()) {
    const reason = escalationReasonFromComment(c.body ?? "");
    if (reason) {
      return reason;
    }
  }
  return null;
}

// Posts `command` and waits until EPURE settles. A first escalation per ticket is resumed with `resume`.
async function drive(
  run: Run,
  token: string,
  command: string,
  resume: string,
  timeoutMinutes: number
): Promise<EpureIssueState> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const before = await readState(run, token);
  let since = { commentId: await postComment(run, command), version: before?.version ?? -1 };
  let idlePolls = 0;
  for (;;) {
    await sleep(POLL_MS);
    const runs = await listRunsSince(run);
    const state = await readState(run, token);
    // EPURE records its own failures as escalations: a failed run means it could not.
    const failed = runs.find((r) => r.path === ISSUE_COMMAND_WORKFLOW && r.conclusion === "failure");
    if (failed) {
      run.escalations.push({ reason: "orchestrator_job_failed", ticket: run.issue, phase: state?.phase ?? "idle", at: new Date().toISOString() });
      throw new Error(`EPURE workflow run failed: ${failed.html_url}`);
    }
    const progress = stepProgress(state, since, runs.filter((r) => r.status !== "completed").length, Date.now());
    if (progress === "suspended" && state) {
      const event: EscalationEvent = {
        reason: state.last_escalation?.reason ?? (await latestEscalationReason(run)) ?? "unrecorded",
        ticket: state.last_escalation?.ticket_number ?? state.active_ticket_number ?? run.issue,
        phase: state.phase,
        at: new Date().toISOString()
      };
      const decision = decideEscalation(run.escalations, event);
      run.escalations.push(event);
      run.log(`[epic] escalation on #${event.ticket} (${event.reason}): ${decision.action}, ${decision.why}`);
      if (decision.action === "stop") {
        throw new Error(`escalation ${event.reason} on #${event.ticket}: ${decision.why}`);
      }
      since = { commentId: await postComment(run, resume), version: state.version };
      idlePolls = 0;
      continue;
    }
    if (progress === "done" || (progress === "settled" && state?.phase !== "implementation" && state?.phase !== "review")) {
      return state!;
    }
    idlePolls = progress === "settled" ? idlePolls + 1 : 0;
    if (idlePolls >= STALL_POLLS) {
      throw new Error(`EPURE stalled in ${state?.phase}/${state?.subphase ?? "idle"} with nothing running`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMinutes} min on "${command.split("\n")[0]}" (phase ${state?.phase}, status ${state?.status})`);
    }
  }
}

function expectState(state: EpureIssueState, phase: EpureIssueState["phase"], status: EpureIssueState["status"]): void {
  if (state.phase !== phase || state.status !== status) {
    throw new Error(`expected ${phase}/${status}, EPURE is at ${state.phase}/${state.status}`);
  }
}

async function resolveEpureSha(gh: GitHubApi, ref: string): Promise<string> {
  const { sha } = await gh.call<{ sha: string }>("GET", `/repos/${EPURE_REPOSITORY}/commits/${encodeURIComponent(ref)}`);
  const bundle = `/repos/${EPURE_REPOSITORY}/contents/actions/orchestrate-issue/action.yml?ref=${sha}`;
  if ((await gh.status("GET", bundle)) !== 200) {
    throw new Error(`${EPURE_REPOSITORY}@${ref} has no actions/orchestrate-issue: push a branch with the built dist/`);
  }
  return sha;
}

async function preflight(config: E2eConfig, gh: GitHubApi): Promise<string> {
  if (!config.agentAppId || !config.releaseAppId) {
    throw new Error("agentAppId and releaseAppId are missing from the e2e config: run the GitHub Apps wizard with --e2e-config");
  }
  if (!config.epureRef || !config.model) {
    throw new Error('the e2e config needs "epureRef" and "model"');
  }
  const R = `/repos/${gh.repository}`;
  const { login } = await gh.call<{ login: string }>("GET", "/user");
  const { permission } = await gh.call<{ permission: string }>("GET", `${R}/collaborators/${login}/permission`);
  if (permission !== "admin" && permission !== "write") {
    throw new Error(`${login} has "${permission}" on ${gh.repository}: /epure commands need write access`);
  }
  const secrets = await gh.call<{ secrets: Array<{ name: string }> }>("GET", `${R}/environments/${config.llmEnvironment}/secrets`, undefined, [200, 404]);
  const missing = AGENT_SECRETS.filter((name) => !(secrets.secrets ?? []).some((s) => s.name === name));
  if (missing.length) {
    throw new Error(`environment "${config.llmEnvironment}" lacks ${missing.join(", ")}: run the GitHub Apps wizard`);
  }
  return resolveEpureSha(gh, config.epureRef);
}

function runSetupRepo(dir: string, config: E2eConfig, repository: string, sha: string, token: string, githubSettings: boolean): void {
  const args = [
    resolve("dist/cli/setup-repo.mjs"),
    ...["--repo", repository, "--dir", dir, "--pinned-sha", sha, "--model", config.model, "--llm-env", config.llmEnvironment, "--apply", "--json"],
    ...(githubSettings
      ? ["--apply-github-settings", "--agent-app-id", String(config.agentAppId), "--release-app-id", String(config.releaseAppId)]
      : [])
  ];
  const out = execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: token } });
  const status = (JSON.parse(out) as { status: string }).status;
  if (status === "error") {
    throw new Error(`setup-repo failed: ${out.slice(0, 2000)}`);
  }
}

// Files land on main and dev before the rulesets exist: the release ruleset would refuse the push.
async function installEpure(run: Run, seedSha: string, sha: string, token: string): Promise<void> {
  const localSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (localSha !== sha) {
    run.log(`[setup-repo] warning: the workflows for EPURE ${sha.slice(0, 12)} come from the local setup-repo at ${localSha.slice(0, 12)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "epure-e2e-"));
  try {
    cpSync(SEED_DIR, dir, { recursive: true });
    runSetupRepo(dir, run.config, run.gh.repository, sha, token, false);
    const commit = await commitFiles(run.gh, readTreeFiles(dir), `chore: install EPURE ${sha.slice(0, 12)} with setup-repo`, [seedSha]);
    await forceBranches(run.gh, ["main", "dev"], commit);
    runSetupRepo(dir, run.config, run.gh.repository, sha, token, true);
    run.log(`[setup-repo] EPURE ${sha.slice(0, 12)} installed at ${commit}, rulesets applied`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function collectUsage(run: Run): Promise<LLMTokenUsage[]> {
  const R = `/repos/${run.gh.repository}`;
  const records: LLMTokenUsage[] = [];
  for (const wr of (await listRunsSince(run)).filter((r) => r.path === ISSUE_COMMAND_WORKFLOW)) {
    const { jobs } = await run.gh.call<{ jobs: Array<{ id: number; name: string; conclusion: string | null }> }>(
      "GET",
      `${R}/actions/runs/${wr.id}/jobs?per_page=100`
    );
    for (const job of jobs.filter((j) => j.name.startsWith("Orchestrate") && j.conclusion !== "skipped")) {
      records.push(...parseUsageLines(await run.gh.text(`${R}/actions/jobs/${job.id}/logs`)));
    }
  }
  return records;
}

async function findFeaturePr(run: Run, state: EpureIssueState | null): Promise<PullRequestRef | null> {
  const pulls = await run.gh.paginate<{ number: number; html_url: string; head: { ref: string } }>(
    `/repos/${run.gh.repository}/pulls?state=open&base=dev`
  );
  const pr = pulls.find((p) => (state?.feature_branch ? p.head.ref === state.feature_branch : p.head.ref.startsWith("feature/")));
  return pr ? { number: pr.number, url: pr.html_url } : null;
}

export async function runSandboxEpic(
  config: E2eConfig,
  gh: GitHubApi,
  token: string,
  log: (line: string) => void
): Promise<{ readonly result: E2eRunResult; readonly dir: string }> {
  const startedMs = Date.now();
  const runId = new Date(startedMs).toISOString().replace(/[:.]/g, "-");
  const run: Run = { config, gh, log, startedAt: new Date(startedMs).toISOString(), escalations: [], issue: 0 };
  const clock = new PhaseClock();
  let epureSha = "";
  let issue: PullRequestRef | null = null;
  let error: string | null = null;

  try {
    epureSha = await clock.time("preflight", () => preflight(config, gh));
    const { seedSha } = await clock.time("reset", () => resetSandbox(gh, log));
    await clock.time("setup_repo", () => installEpure(run, seedSha, epureSha, token));

    const created = await gh.call<{ number: number; html_url: string }>("POST", `/repos/${gh.repository}/issues`, { title: EPIC_TITLE, body: EPIC_BODY });
    run.issue = created.number;
    issue = { number: created.number, url: created.html_url };
    log(`[epic] created ${created.html_url}`);

    const planning = config.planningStepTimeoutMinutes;
    let state = await clock.time("plan", () => drive(run, token, "/epure plan", "/epure plan", planning));
    await clock.time("grilling", async () => {
      for (let i = 0; i < config.maxGrillReplies && state.phase === "grilling" && state.status === "active"; i += 1) {
        const answer = GRILL_ANSWERS[Math.min(i, GRILL_ANSWERS.length - 1)]!;
        state = await drive(run, token, answer, answer, planning);
      }
    });
    state = await clock.time("spec", () => drive(run, token, "/epure to-spec", "/epure to-spec", planning));
    expectState(state, "spec", "awaiting_human_approval");
    state = await clock.time("tickets", () => drive(run, token, "/epure to-tickets", "/epure to-tickets", planning));
    expectState(state, "tickets", "awaiting_human_approval");
    await clock.time("implementation", () =>
      drive(run, token, "/epure approve", "/epure continue", config.implementationTimeoutMinutes)
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log(`[e2e] stopped: ${error}`);
  }

  const dir = resolve(config.outputDir, runId);
  mkdirSync(dir, { recursive: true });
  const finalState = run.issue ? await readState(run, token).catch(() => null) : null;
  const featurePr = run.issue ? await findFeaturePr(run, finalState) : null;
  const usageRecords = await collectUsage(run).catch((err: unknown) => {
    log(`[e2e] usage collection failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  if (run.issue) {
    const comments = await gh.paginate<unknown>(`/repos/${gh.repository}/issues/${run.issue}/comments`);
    writeFileSync(join(dir, "comments.json"), `${JSON.stringify(comments, null, 2)}\n`);
  }
  writeFileSync(join(dir, "usage.jsonl"), usageRecords.map((r) => JSON.stringify(r)).join("\n"));

  const { success, checks } = evaluateRun(featurePr, run.escalations);
  const endedMs = Date.now();
  const result: E2eRunResult = {
    schema_version: 1,
    run_id: runId,
    repository: gh.repository,
    epure_ref: config.epureRef,
    epure_sha: epureSha,
    model: config.model,
    started_at: run.startedAt,
    ended_at: new Date(endedMs).toISOString(),
    duration_ms: endedMs - startedMs,
    issue,
    tickets: finalState?.plan_manifest?.tickets.map((t) => t.ticketIssueNumber) ?? [],
    feature_pr: featurePr,
    phases: clock.phases,
    usage: summarizeUsage(usageRecords, config.pricing),
    escalations: run.escalations,
    success,
    checks,
    error
  };
  writeFileSync(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderMarkdownReport(result));
  return { result, dir };
}
