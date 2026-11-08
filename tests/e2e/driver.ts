import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildIssueStateRefName,
  createGitHubApiRefStateStore,
  readRunLease,
  type EpureIssueState
} from "../../src/state/git-ref-state.js";
import type { E2eConfig } from "./config.js";
import { EPIC_BODY, EPIC_TITLE, GRILL_ANSWERS } from "./epic.js";
import { classifyEscalation } from "./escalations.js";
import { createOnce, type GitHubApi } from "./github.js";
import {
  acceptedEndState,
  actionsMinutes,
  assessComparability,
  attributeUsage,
  decideEscalation,
  deriveEngine,
  escalationReasonFromComment,
  evaluateRun,
  hostClock,
  parseUsageLines,
  PhaseClock,
  renderMarkdownReport,
  RESUME_POLICY,
  summarizeUsage,
  summarizeUsageByPhase,
  type ActionsJob,
  type E2eRunResult,
  type EngineRecord,
  type EscalationEvent,
  type HarnessSettings,
  type JobFailure,
  type PullRequestRef,
  type ResumeEvent,
  type Unknowns,
  type UsageLine
} from "./report.js";
import { commitTree, forceBranches, resetSandbox, SEED_PATH, verifyDestructiveTarget, type TreeFile } from "./reset.js";

const EPURE_REPOSITORY = "Giskard-AI/epure";
const ISSUE_COMMAND_WORKFLOW = ".github/workflows/epure-issue-command.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const POLL_MS = 30_000;
// Polls with nothing running and the plan still active before the harness calls it stalled.
const STALL_POLLS = 6;
const INSTALL_CI_POLL_MS = 15_000;
// The install commit's CI must have started by then.
const INSTALL_CI_START_MS = 180_000;
const AGENT_SECRETS = ["EPURE_AGENT_APP_ID", "EPURE_AGENT_APP_PRIVATE_KEY", "LLM_API_KEY"];
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

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

// Implementation and review settle between tickets with nothing running; they end at Gate 3, awaiting the human merge into dev.
export function stepDone(progress: StepProgress, state: Pick<EpureIssueState, "phase" | "status">): boolean {
  if (progress === "done") {
    return true;
  }
  if (progress !== "settled") {
    return false;
  }
  return state.status === "awaiting_human_approval" || (state.phase !== "implementation" && state.phase !== "review");
}

export function codeUnderTestProblems(input: {
  readonly pinnedSha: string;
  readonly headSha: string;
  readonly dirty: string;
  readonly distDrift: string;
}): string[] {
  return [
    ...(input.headSha === input.pinnedSha
      ? []
      : [`the local checkout is at ${input.headSha.slice(0, 12)}, the pinned EPURE commit is ${input.pinnedSha.slice(0, 12)}`]),
    ...(input.dirty ? [`the worktree has uncommitted changes:\n${input.dirty}`] : []),
    ...(input.distDrift ? [`dist/ at the pinned commit does not match its source (rebuild, commit, push):\n${input.distDrift}`] : [])
  ];
}

interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly head_branch: string | null;
}

export type InstallCiVerdict =
  | { readonly state: "pending" }
  | { readonly state: "green" }
  | { readonly state: "red"; readonly failed: readonly string[] };

// Red as soon as one job fails, so a broken install stops the run within minutes.
export function installCiVerdict(
  runs: ReadonlyArray<Pick<WorkflowRun, "path" | "status" | "conclusion">>,
  failedJobs: readonly string[]
): InstallCiVerdict {
  const failed = [
    ...failedJobs,
    ...runs
      .filter((r) => r.status === "completed" && !GREEN_CONCLUSIONS.has(r.conclusion ?? ""))
      .map((r) => `${r.path} (${r.conclusion ?? "no conclusion"})`)
  ];
  if (failed.length) {
    return { state: "red", failed };
  }
  if (!runs.some((r) => r.path === CI_WORKFLOW) || runs.some((r) => r.status !== "completed")) {
    return { state: "pending" };
  }
  return { state: "green" };
}

// EPURE passes HIGH explicitly or lets the Google provider default Gemini 3 to HIGH; it sets none for other providers.
export function thinkingLevelFor(model: string): string {
  return /^google\/gemini-3/i.test(model) ? "HIGH" : "provider default";
}

interface Run {
  readonly config: E2eConfig;
  readonly gh: GitHubApi;
  readonly log: (line: string) => void;
  readonly startedAt: string;
  readonly escalations: EscalationEvent[];
  readonly resumes: ResumeEvent[];
  readonly jobFailures: JobFailure[];
  readonly postedComments: Set<number>;
  issue: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (args: readonly string[]) => execFileSync("git", args, { encoding: "utf8" });

async function listRunsSince(run: Pick<Run, "gh" | "startedAt">): Promise<WorkflowRun[]> {
  return run.gh.paginate<WorkflowRun>(
    `/repos/${run.gh.repository}/actions/runs?created=${encodeURIComponent(`>=${run.startedAt}`)}`,
    (page) => (page as { workflow_runs: WorkflowRun[] }).workflow_runs
  );
}

async function readState(run: Run, token: string): Promise<EpureIssueState | null> {
  const store = createGitHubApiRefStateStore({ repository: run.gh.repository, githubToken: token, fetchImpl: run.gh.fetch });
  return (await store.readRef(buildIssueStateRefName(run.issue))).state;
}

interface IssueComment {
  readonly id: number;
  readonly body?: string | undefined;
  readonly performed_via_github_app?: { readonly id: number } | null | undefined;
}

// The harness posts the same command again on a resume: only a comment it has not recorded can be the lost one.
export function lostComment(comments: readonly IssueComment[], body: string, posted: ReadonlySet<number>): IssueComment | null {
  return comments.find((c) => c.body === body && !c.performed_via_github_app && !posted.has(c.id)) ?? null;
}

async function postComment(run: Run, body: string): Promise<number> {
  const path = `/repos/${run.gh.repository}/issues/${run.issue}/comments`;
  const comment = await createOnce(
    () => run.gh.call<IssueComment>("POST", path, { body }),
    async () => lostComment(await run.gh.paginate<IssueComment>(path), body, run.postedComments)
  );
  run.postedComments.add(comment.id);
  run.log(`[epic] #${run.issue} <- ${body.split("\n")[0]!.slice(0, 80)}`);
  return comment.id;
}

// Only the agent App speaks for EPURE: a human comment quoting an escalation heading is ignored.
async function latestEscalationReason(run: Run): Promise<string | null> {
  const comments = await run.gh.paginate<IssueComment>(`/repos/${run.gh.repository}/issues/${run.issue}/comments`);
  for (const c of comments.reverse()) {
    const reason = c.performed_via_github_app?.id === run.config.agentAppId ? escalationReasonFromComment(c.body ?? "") : null;
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
    const failed = runs.find((r) => r.path === ISSUE_COMMAND_WORKFLOW && FAILED_CONCLUSIONS.has(r.conclusion ?? ""));
    if (failed) {
      run.jobFailures.push({
        run_id: failed.id,
        url: failed.html_url,
        conclusion: failed.conclusion ?? "",
        phase: state?.phase ?? "idle",
        at: new Date().toISOString()
      });
      throw new Error(`EPURE workflow run failed: ${failed.html_url}`);
    }
    const progress = stepProgress(state, since, runs.filter((r) => r.status !== "completed").length, Date.now());
    if (progress === "suspended" && state) {
      const reason = state.last_escalation?.reason ?? (await latestEscalationReason(run)) ?? "unrecorded";
      const event: EscalationEvent = {
        reason,
        class: classifyEscalation(reason),
        ticket: state.last_escalation?.ticket_number ?? state.active_ticket_number ?? run.issue,
        phase: state.phase,
        at: new Date().toISOString()
      };
      const decision = decideEscalation(run.escalations, event);
      run.escalations.push(event);
      run.log(`[epic] escalation on #${event.ticket} (${event.reason}, ${event.class}): ${decision.action}, ${decision.why}`);
      if (decision.action === "stop") {
        throw new Error(`escalation ${event.reason} on #${event.ticket}: ${decision.why}`);
      }
      const commentId = await postComment(run, resume);
      run.resumes.push({ at: new Date().toISOString(), ticket: event.ticket, command: resume.split("\n")[0]! });
      since = { commentId, version: state.version };
      idlePolls = 0;
      continue;
    }
    if (state && stepDone(progress, state)) {
      return state;
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

interface ClockSample {
  readonly wallMs: number;
  readonly monotonicMs: number;
  readonly githubMs: number;
}

// GitHub's Date header has a 1 s resolution: the local times are the midpoint of the request.
async function sampleClock(gh: GitHubApi): Promise<ClockSample> {
  const wallBefore = Date.now();
  const monotonicBefore = performance.now();
  const resp = await gh.fetch("https://api.github.com/rate_limit");
  await resp.body?.cancel();
  const githubMs = Date.parse(resp.headers.get("date") ?? "");
  if (Number.isNaN(githubMs)) {
    throw new Error("GitHub answered without a Date header");
  }
  return { wallMs: (wallBefore + Date.now()) / 2, monotonicMs: (monotonicBefore + performance.now()) / 2, githubMs };
}

const MAX_CLOCK_SKEW_MS = 30_000;

async function resolveEpureSha(gh: GitHubApi, ref: string): Promise<string> {
  const { sha } = await gh.call<{ sha: string }>("GET", `/repos/${EPURE_REPOSITORY}/commits/${encodeURIComponent(ref)}`);
  const bundle = `/repos/${EPURE_REPOSITORY}/contents/actions/orchestrate-issue/action.yml?ref=${sha}`;
  if ((await gh.status("GET", bundle)) !== 200) {
    throw new Error(`${EPURE_REPOSITORY}@${ref} has no actions/orchestrate-issue: push a branch with the built dist/`);
  }
  return sha;
}

// The local setup-repo writes the sandbox workflows, so the checkout must be the pinned commit, clean, with its own dist/.
function verifyCodeUnderTest(pinnedSha: string): string {
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const checkout = { pinnedSha, headSha, dirty: git(["status", "--porcelain"]).trim(), distDrift: "" };
  let problems = codeUnderTestProblems(checkout);
  if (problems.length === 0) {
    execFileSync(process.execPath, ["scripts/build-actions.mjs"], { stdio: "ignore" });
    const distDrift = git(["status", "--porcelain", "--", "dist"]).trim();
    if (distDrift) {
      // The worktree was clean: every change under dist/ comes from this build.
      git(["checkout", "--", "dist"]);
      git(["clean", "-fdq", "--", "dist"]);
    }
    problems = codeUnderTestProblems({ ...checkout, distDrift });
  }
  if (problems.length) {
    throw new Error(`refusing to run: ${problems.join("; ")}`);
  }
  return headSha;
}

async function preflight(
  config: E2eConfig,
  gh: GitHubApi,
  clock: ClockSample
): Promise<{ readonly epureSha: string; readonly harnessCommit: string }> {
  // The run window (created>=started_at) and the phase timings compare local time with GitHub's.
  const skewMs = clock.wallMs - clock.githubMs;
  if (Math.abs(skewMs) > MAX_CLOCK_SKEW_MS) {
    throw new Error(`the local clock is ${(skewMs / 1000).toFixed(0)} s off GitHub's: sync it (e.g. \`sudo hwclock -s\` in WSL)`);
  }
  if (!config.agentAppId || !config.releaseAppId) {
    throw new Error("agentAppId and releaseAppId are missing from the e2e config: run the GitHub Apps wizard with --e2e-config");
  }
  if (!config.epureRef || !config.model) {
    throw new Error('the e2e config needs "epureRef" and "model"');
  }
  const epureSha = await resolveEpureSha(gh, config.epureRef);
  const harnessCommit = verifyCodeUnderTest(epureSha);
  await verifyDestructiveTarget(gh);
  const secrets = await gh.call<{ secrets?: Array<{ name: string }> }>(
    "GET",
    `/repos/${gh.repository}/environments/${config.llmEnvironment}/secrets`,
    undefined,
    [200, 404]
  );
  const missing = AGENT_SECRETS.filter((name) => !(secrets.secrets ?? []).some((s) => s.name === name));
  if (missing.length) {
    throw new Error(`environment "${config.llmEnvironment}" lacks ${missing.join(", ")}: run the GitHub Apps wizard`);
  }
  return { epureSha, harnessCommit };
}

function runSetupRepo(dir: string, config: E2eConfig, repository: string, sha: string, token: string, githubSettings: boolean): string[] {
  const args = [
    resolve("dist/cli/setup-repo.mjs"),
    ...["--repo", repository, "--dir", dir, "--pinned-sha", sha, "--model", config.model, "--llm-env", config.llmEnvironment, "--apply", "--json"],
    ...(githubSettings
      ? ["--apply-github-settings", "--agent-app-id", String(config.agentAppId), "--release-app-id", String(config.releaseAppId)]
      : [])
  ];
  const out = execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: token } });
  const result = JSON.parse(out) as { status: string; mutated_files: string[] };
  if (result.status === "error") {
    throw new Error(`setup-repo failed: ${out.slice(0, 2000)}`);
  }
  return result.mutated_files;
}

async function waitForInstallCi(run: Run, sha: string): Promise<void> {
  const R = `/repos/${run.gh.repository}`;
  const started = Date.now();
  for (;;) {
    await sleep(INSTALL_CI_POLL_MS);
    const runs = await run.gh.paginate<WorkflowRun>(
      `${R}/actions/runs?head_sha=${sha}`,
      (page) => (page as { workflow_runs: WorkflowRun[] }).workflow_runs
    );
    const failedJobs: string[] = [];
    for (const wr of runs.filter((r) => r.status !== "completed")) {
      const { jobs } = await run.gh.call<{ jobs: Array<{ name: string; conclusion: string | null }> }>(
        "GET",
        `${R}/actions/runs/${wr.id}/jobs?per_page=100`
      );
      failedJobs.push(...jobs.filter((j) => FAILED_CONCLUSIONS.has(j.conclusion ?? "")).map((j) => `${wr.path}: ${j.name} ${wr.html_url}`));
    }
    const verdict = installCiVerdict(runs, failedJobs);
    if (verdict.state === "green") {
      run.log(`[setup-repo] CI green on the install commit ${sha.slice(0, 12)}`);
      return;
    }
    if (verdict.state === "red") {
      throw new Error(`CI is red on the install commit ${sha.slice(0, 12)}: ${verdict.failed.join(", ")}`);
    }
    const elapsed = Date.now() - started;
    if (!runs.some((r) => r.path === CI_WORKFLOW) && elapsed > INSTALL_CI_START_MS) {
      throw new Error(`no CI run started for the install commit ${sha.slice(0, 12)}`);
    }
    if (elapsed > run.config.installCiTimeoutMinutes * 60_000) {
      throw new Error(`CI on the install commit ${sha.slice(0, 12)} still running after ${run.config.installCiTimeoutMinutes} min`);
    }
  }
}

// Files land on main and dev before the rulesets exist: the release ruleset would refuse the push.
async function installEpure(
  run: Run,
  seed: { readonly commitSha: string; readonly treeSha: string },
  sha: string,
  token: string
): Promise<{ readonly commitSha: string; readonly engine: EngineRecord }> {
  const dir = mkdtempSync(join(tmpdir(), "epure-e2e-"));
  try {
    // The committed seed only, with its file modes: what the sandbox received at reset.
    execFileSync("tar", ["-x", "-C", dir], { input: execFileSync("git", ["archive", "--format=tar", `HEAD:${SEED_PATH}`]) });
    const files: TreeFile[] = runSetupRepo(dir, run.config, run.gh.repository, sha, token, false).map((path) => ({
      path,
      mode: statSync(join(dir, path)).mode & 0o111 ? "100755" : "100644",
      content: readFileSync(join(dir, path))
    }));
    const { commitSha } = await commitTree(run.gh, files, `chore: install EPURE ${sha.slice(0, 12)} with setup-repo`, [seed.commitSha], seed.treeSha);
    await forceBranches(run.gh, ["main", "dev"], commitSha);
    const engine = deriveEngine(readFileSync(join(dir, ISSUE_COMMAND_WORKFLOW), "utf8"), readFileSync(join(dir, ".github/agents.yml"), "utf8"));
    runSetupRepo(dir, run.config, run.gh.repository, sha, token, true);
    run.log(`[setup-repo] EPURE ${sha.slice(0, 12)} installed at ${commitSha}, rulesets applied, engine ${engine.executed}`);
    return { commitSha, engine };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface RunEvidence {
  readonly usage: ReadonlyArray<UsageLine & { readonly run_id: number; readonly job_id: number }>;
  readonly jobs: readonly ActionsJob[];
  readonly unavailableJobLogs: readonly number[];
  readonly taskBranchCiRuns: number;
}

export interface WorkflowJob {
  readonly id: number;
  readonly conclusion: string | null;
  readonly runner_name: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

// GitHub stamps skipped jobs with start and end times but gives them no runner, no log and no bill.
export function ranOnRunner(job: WorkflowJob): boolean {
  return job.conclusion !== "skipped" && Boolean(job.runner_name);
}

export async function collectEvidence(run: Pick<Run, "gh" | "startedAt">): Promise<RunEvidence> {
  const R = `/repos/${run.gh.repository}`;
  const runs = await listRunsSince(run);
  const usage: Array<UsageLine & { run_id: number; job_id: number }> = [];
  const jobs: ActionsJob[] = [];
  const unavailableJobLogs: number[] = [];
  for (const wr of runs) {
    const ran = (
      await run.gh.paginate<WorkflowJob>(`${R}/actions/runs/${wr.id}/jobs`, (page) => (page as { jobs: WorkflowJob[] }).jobs)
    ).filter(ranOnRunner);
    jobs.push(...ran.map((j) => ({ workflow: wr.path, started_at: j.started_at, completed_at: j.completed_at })));
    if (wr.path !== ISSUE_COMMAND_WORKFLOW) {
      continue;
    }
    for (const job of ran) {
      const log = await run.gh.text(`${R}/actions/jobs/${job.id}/logs`);
      if (log === null) {
        unavailableJobLogs.push(job.id);
        continue;
      }
      usage.push(...parseUsageLines(log).map((line) => ({ ...line, run_id: wr.id, job_id: job.id })));
    }
  }
  return {
    usage,
    jobs,
    unavailableJobLogs,
    taskBranchCiRuns: runs.filter((r) => r.path === CI_WORKFLOW && r.head_branch?.startsWith("task/")).length
  };
}

async function countReviewedTaskPrs(gh: GitHubApi): Promise<number> {
  const pulls = await gh.paginate<{ number: number; head: { ref: string } }>(`/repos/${gh.repository}/pulls?state=all`);
  let reviewed = 0;
  for (const pr of pulls.filter((p) => p.head.ref.startsWith("task/"))) {
    const reviews = await gh.call<unknown[]>("GET", `/repos/${gh.repository}/pulls/${pr.number}/reviews?per_page=1`);
    reviewed += reviews.length > 0 ? 1 : 0;
  }
  return reviewed;
}

async function findFeaturePr(run: Run, state: EpureIssueState | null): Promise<PullRequestRef | null> {
  const pulls = await run.gh.paginate<{ number: number; html_url: string; head: { ref: string } }>(
    `/repos/${run.gh.repository}/pulls?state=open&base=dev`
  );
  const pr = pulls.find((p) => (state?.feature_branch ? p.head.ref === state.feature_branch : p.head.ref.startsWith("feature/")));
  return pr ? { number: pr.number, url: pr.html_url } : null;
}

interface CreatedIssue {
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly created_at: string;
  readonly pull_request?: unknown;
}

export async function runSandboxEpic(
  config: E2eConfig,
  gh: GitHubApi,
  token: string,
  log: (line: string) => void
): Promise<{ readonly result: E2eRunResult; readonly dir: string }> {
  const startedMs = Date.now();
  // The monotonic clock stops while the host sleeps; the wall clock does not; GitHub's tells which one moved.
  let clockStart: ClockSample = { wallMs: startedMs, monotonicMs: performance.now(), githubMs: Number.NaN };
  const runId = new Date(startedMs).toISOString().replace(/[:.]/g, "-");
  const run: Run = {
    config,
    gh,
    log,
    startedAt: new Date(startedMs).toISOString(),
    escalations: [],
    resumes: [],
    jobFailures: [],
    postedComments: new Set(),
    issue: 0
  };
  const settings: HarnessSettings = {
    model: config.model,
    thinking_level: thinkingLevelFor(config.model),
    llm_environment: config.llmEnvironment,
    max_grill_replies: config.maxGrillReplies,
    planning_step_timeout_minutes: config.planningStepTimeoutMinutes,
    implementation_timeout_minutes: config.implementationTimeoutMinutes,
    install_ci_timeout_minutes: config.installCiTimeoutMinutes,
    poll_interval_ms: POLL_MS,
    stall_polls: STALL_POLLS
  };
  const clock = new PhaseClock();
  let code = { epureSha: "", harnessCommit: "" };
  let seed = { commitSha: "", treeSha: "" };
  let install: { commitSha: string; engine: EngineRecord | null } = { commitSha: "", engine: null };
  let issue: PullRequestRef | null = null;
  let error: string | null = null;

  try {
    code = await clock.time("preflight", async () => {
      clockStart = await sampleClock(gh);
      return preflight(config, gh, clockStart);
    });
    const reset = await clock.time("reset", () => resetSandbox(gh, log));
    seed = { commitSha: reset.seedCommitSha, treeSha: reset.seedTreeSha };
    install = await clock.time("setup_repo", () => installEpure(run, seed, code.epureSha, token));
    await clock.time("install_ci", () => waitForInstallCi(run, install.commitSha));

    const created = await createOnce(
      () => gh.call<CreatedIssue>("POST", `/repos/${gh.repository}/issues`, { title: EPIC_TITLE, body: EPIC_BODY }),
      async () =>
        (await gh.paginate<CreatedIssue>(`/repos/${gh.repository}/issues?state=all&since=${encodeURIComponent(run.startedAt)}`)).find(
          (i) => !i.pull_request && i.title === EPIC_TITLE && Date.parse(i.created_at) >= startedMs
        ) ?? null
    );
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
    state = await clock.time("implementation", () =>
      drive(run, token, "/epure approve", RESUME_POLICY.resume_command, config.implementationTimeoutMinutes)
    );
    if (!acceptedEndState(state)) {
      throw new Error(`expected review/awaiting_human_approval (Gate 3) or completed/done, EPURE is at ${state.phase}/${state.status}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log(`[e2e] stopped: ${error}`);
  }

  const dir = resolve(config.outputDir, runId);
  mkdirSync(dir, { recursive: true });
  const unknown: Partial<Record<keyof Unknowns, string>> = {};
  // A failed read leaves its result field null and says why, so result.json is always written.
  const attempt = async <T>(field: keyof Unknowns, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      unknown[field] = err instanceof Error ? err.message : String(err);
      log(`[e2e] ${field} unknown: ${unknown[field]}`);
      return null;
    }
  };
  const finalState = run.issue ? await attempt("end_state", () => readState(run, token)) : null;
  const featurePr = run.issue ? await attempt("feature_pr", () => findFeaturePr(run, finalState)) : null;
  const evidence = await attempt("usage", () => collectEvidence(run));
  if (!evidence) {
    unknown.actions = unknown.usage!;
  } else if (evidence.unavailableJobLogs.length) {
    log(`[e2e] no log for orchestrator jobs ${evidence.unavailableJobLogs.join(", ")}: their LLM usage is missing`);
  }
  const reviewedTaskPrs = run.issue ? await attempt("reviewed_task_prs", () => countReviewedTaskPrs(gh)) : 0;
  if (run.issue) {
    const comments = await attempt("comments", () => gh.paginate<unknown>(`/repos/${gh.repository}/issues/${run.issue}/comments`));
    if (comments) {
      writeFileSync(join(dir, "comments.json"), `${JSON.stringify(comments, null, 2)}\n`);
    }
  }
  const records = evidence ? attributeUsage(evidence.usage, clock.phases, run.resumes) : [];
  writeFileSync(join(dir, "usage.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));

  const endState = finalState ? { phase: finalState.phase, status: finalState.status, subphase: finalState.subphase ?? null } : null;
  const tickets = unknown.end_state ? null : (finalState?.plan_manifest?.tickets.map((t) => t.ticketIssueNumber) ?? []);
  const { success, checks } = evaluateRun({
    endState,
    error,
    featurePr,
    escalations: run.escalations,
    jobFailures: run.jobFailures,
    usageRecords: records.length,
    unavailableJobLogs: evidence?.unavailableJobLogs ?? [],
    unknown
  });
  const clockEnd = await attempt("host_clock", () => sampleClock(gh));
  const endedMs = clockEnd?.wallMs ?? Date.now();
  const githubElapsedMs = clockEnd && !Number.isNaN(clockStart.githubMs) ? clockEnd.githubMs - clockStart.githubMs : null;
  const host = hostClock({
    wallMs: endedMs - clockStart.wallMs,
    monotonicMs: (clockEnd?.monotonicMs ?? performance.now()) - clockStart.monotonicMs,
    githubMs: githubElapsedMs
  });
  const result: E2eRunResult = {
    schema_version: 3,
    run_id: runId,
    repository: gh.repository,
    code_under_test: { epure_ref: config.epureRef, epure_sha: code.epureSha, harness_commit: code.harnessCommit },
    seed: { tree_sha: seed.treeSha, commit_sha: seed.commitSha },
    install_commit_sha: install.commitSha,
    engine: install.engine,
    settings,
    resume_policy: RESUME_POLICY,
    pricing: { source: config.pricingSource, table: config.pricing },
    started_at: run.startedAt,
    ended_at: new Date(endedMs).toISOString(),
    duration_ms: endedMs - startedMs,
    host_clock: { ...host, start_skew_ms: Number.isNaN(clockStart.githubMs) ? null : Math.round(clockStart.wallMs - clockStart.githubMs) },
    issue,
    end_state: endState && { ...endState, accepted: acceptedEndState(endState)?.label ?? null },
    tickets,
    feature_pr: featurePr,
    phases: clock.phases,
    usage: evidence && {
      ...summarizeUsage(records, config.pricing),
      by_phase: summarizeUsageByPhase(records, config.pricing),
      unavailable_job_logs: evidence.unavailableJobLogs,
      records
    },
    actions: evidence && actionsMinutes(evidence.jobs),
    reviewed_task_prs: reviewedTaskPrs,
    escalations: run.escalations,
    resumes: run.resumes,
    job_failures: run.jobFailures,
    comparable: assessComparability({
      endState,
      error,
      tickets: tickets?.length ?? null,
      taskBranchCiRuns: evidence?.taskBranchCiRuns ?? null,
      reviewedTaskPrs,
      hostClock: host
    }),
    unknown,
    success,
    checks,
    error
  };
  writeFileSync(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderMarkdownReport(result));
  return { result, dir };
}
