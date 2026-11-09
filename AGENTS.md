# AGENTS.md — EPURE (`Giskard-AI/epure`)

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues (`Giskard-AI/epure`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context domain layout (`GLOSSARY.md` at repo root and ADRs in `docs/adr/`). See `docs/agents/domain.md`.

### Live LLM & Orchestrator Verification (`npm run test:live`)

When modifying `src/llm/**` or `src/orchestrator/**`, mocked unit tests (`npm test`) are necessary but not sufficient. Validate against real LLM endpoints using the agnostic live harness:

1. Copy `epure.live-test.example.json` to `epure.live-test.json` (git-ignored) or set `EPURE_LIVE_TEST_CONFIG` / `EPURE_LIVE_TEST_TARGETS_JSON` with the list of LLM target configurations to verify.
2. Run `npm run test:live` (never log or print API keys in stdout/stderr).

### Live GitHub Verification (`npm run test:live:github`)

When modifying `src/orchestrator/github/**`, `src/state/**` or `src/auth/**`, mocked unit tests (`npm test`) are necessary but not sufficient. Validate against a real sandbox repository (name must contain `sandbox`; the App installation must reach only that repo):

1. Run `scripts/wizards/setup-live-github-sandbox-wizard.sh` once, or copy `epure.live-github.example.json` to `epure.live-github.json` (git-ignored), or point `EPURE_LIVE_GITHUB_CONFIG` at a config file, or set `EPURE_LIVE_GITHUB_REPOSITORY`, `EPURE_LIVE_GITHUB_APP_ID`, `EPURE_LIVE_GITHUB_APP_PRIVATE_KEY_PATH` (or `EPURE_LIVE_GITHUB_APP_PRIVATE_KEY`) and optionally `EPURE_LIVE_GITHUB_INSTALLATION_ID`.
2. Run `npm run test:live:github` (it sets the required opt-in flag `EPURE_LIVE_GITHUB=1`; without it the suite skips). The `setup-repo` ruleset cases also need `EPURE_LIVE_GITHUB_ADMIN_TOKEN`: a fine-grained personal access token whose repository access is only the sandbox repository, with `Administration: write` (not a broad `gh auth token`); they only create and delete rulesets scoped to the run namespace, and skip without it. It namespaces everything under `live/<run-id>/`, then deletes refs/branches and closes PRs (best effort, plus namespaces older than 24 h). Never log or print App private keys or tokens.
3. The PR-checks case (#105e) also needs `Workflows: write` and `Actions: read` on the sandbox App and skips without them. Once granted, the App holds `workflows: write` permanently: anyone with its private key can commit a workflow to the sandbox repository and run it there. Keep the sandbox repository free of real secrets (no Actions secrets, environments, deploy keys or variables worth stealing).

### End-to-End Sandbox Run (`npm run test:e2e`)

Before each major or minor release, run real EPURE end to end on `Giskard-AI/epure-e2e-sandbox`, a private repository reserved for this suite (never `Giskard-AI/epure-live-sandbox`; the harness refuses it and any repository whose name lacks `sandbox`). The run resets the sandbox to the seed project in `tests/e2e/seed/` (a test suite and a `CI` workflow), installs EPURE with `setup-repo` pinned to the commit under test, then drives the scripted epic of `tests/e2e/epic.ts`: `/epure plan`, scripted grilling answers, `/epure to-spec`, `/epure to-tickets` and `/epure approve`, until the `feature/*` -> `dev` pull request opens and EPURE waits at Gate 3 (`review` / `awaiting_human_approval`) for the human merge into `dev`, which the harness never performs. Implementation that settles with nothing running and EPURE still `active` counts as a stall.

Human prerequisites, once:

1. A GitHub token for the harness. Prefer a fine-grained personal access token in `EPURE_E2E_GITHUB_TOKEN`: resource owner `Giskard-AI`, repository access `Giskard-AI/epure-e2e-sandbox` only, and these repository permissions:
   - Actions: read and write (list runs and jobs, read job logs, cancel runs at reset).
   - Administration: read and write (merge settings and rulesets written by `setup-repo`, ruleset deletion at reset).
   - Contents: read and write (blobs, trees, commits and refs of the seed and the install commit).
   - Environments: read (names of the agent environment's secrets).
   - Issues: read and write (the epic, every `/epure` comment, issue deletion at reset).
   - Metadata: read (mandatory).
   - Pull requests: read and write (close leftover pull requests, read task pull request reviews).
   - Workflows: read and write (push `.github/workflows`).

   The token's user must be an admin of the sandbox and posts every `/epure` command. Without `EPURE_E2E_GITHUB_TOKEN` the harness falls back to `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`, which usually reaches every repository of the user; such a classic token needs the `repo` and `workflow` scopes (`gh auth refresh -h github.com -s workflow`).
2. `bash scripts/wizards/setup-github-apps-wizard.sh --repo Giskard-AI/epure-e2e-sandbox --llm-env epure-agent --app-name-prefix giskard-ai-epure-e2e --llm-api-key-file ~/.config/epure/gemini.apikey --e2e-config epure.e2e.json`: it creates the two dedicated Apps, installs them on the sandbox only, stores their keys and the LLM key in the sandbox's GitHub Environments, and writes the App IDs to `epure.e2e.json` (git-ignored, no secrets). With `--e2e-config` it refuses any `--repo` whose name lacks `sandbox` or that is `epure-live-sandbox`.

Each run:

1. Push the EPURE commit under test with its built `dist/`, set `epureRef` (branch, tag or SHA) in `epure.e2e.json`, and run from a clean checkout of exactly that commit: the local `dist/cli/setup-repo.mjs` writes the sandbox's caller workflows. The harness refuses to start when `HEAD` is not the commit `epureRef` resolves to, when the worktree has uncommitted changes, or when rebuilding `dist/` changes it. Commit seed edits first: the reset uploads the committed `tests/e2e/seed` tree (file modes kept, never `node_modules`) and checks that the uploaded tree has git's tree SHA.
2. Run `npm run test:e2e` (it takes hours; `npm run test:e2e:reset` only resets). The run writes `result.json`, `report.md`, `usage.jsonl` and `comments.json` to `.scratch/e2e/<run-id>/`.

Before any destructive call, the harness reads the repository without following redirects: its `full_name` must equal `repository`, it must be private and not `epure-live-sandbox`, the token's user must be an admin, and a classic token must carry `repo` and `workflow`. After pushing the install commit to `main` and `dev`, it waits for that commit's CI and stops as soon as a job is red. The GitHub client gives each request 60 s, retries 5xx responses, network errors and timeouts up to 6 times with exponential backoff (EPURE state reads included), and waits out primary and secondary rate limits with `createGitHubRateLimitedFetch`. It never replays the creation of an issue or a comment: after a lost response it looks for the issue or for a comment it has not recorded yet, and posts again only when none landed.

Settings live in `epure.e2e.json` (see `epure.e2e.example.json`); `EPURE_E2E_CONFIG` points at another file. An environment override may fill a setting the file lacks; when both are set they must be equal, or the harness stops.

| Setting | Override | Default | Meaning |
| --- | --- | --- | --- |
| `repository` | `EPURE_E2E_REPOSITORY` | required | The sandbox repository. |
| `epureRef` | `EPURE_E2E_EPURE_REF` | required for a run | Branch, tag or SHA of `Giskard-AI/epure` under test. |
| `model` | `EPURE_E2E_MODEL` | required for a run | One `<provider>/<model>` for every phase. |
| `llmEnvironment` | | `epure-agent` | GitHub Environment holding the agent App key and `LLM_API_KEY`. |
| `agentAppId`, `releaseAppId` | `EPURE_E2E_AGENT_APP_ID`, `EPURE_E2E_RELEASE_APP_ID` | written by the wizard | The sandbox's two Apps. |
| `pricing` | | `{}` | USD per million tokens keyed by `<provider>/<model>`: `inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok`. A run needs an entry for `model`: the harness writes it into the sandbox's `.github/agents.yml` (`input_per_mtok`, `output_per_mtok`, `cached_input_per_mtok`, `source`, `read_on`) so EPURE shows costs on GitHub. |
| `pricingSource` | | empty | Where and when the prices were read; a run needs `read YYYY-MM-DD` in it, written as `read_on`. |
| `outputDir` | | `.scratch/e2e` | Parent directory of each run's results. |
| `maxGrillReplies` | | `3` | Scripted grilling answers before `/epure to-spec`. |
| `planningStepTimeoutMinutes` | | `30` | Limit for each planning command. |
| `implementationTimeoutMinutes` | | `240` | Limit from `/epure approve` to the feature pull request. |
| `installCiTimeoutMinutes` | | `20` | Limit for the install commit's CI. |

`result.json` is the baseline record: both SHAs (`epure_sha` under test and the `harness_commit` that ran), the seed tree SHA, the engine that ran (read from the installed caller workflow; the in-house loop ignores `agents.yml`'s `harness`), every setting including the thinking level, the resume policy, the pricing table and its source, phase timings, every usage record with its timestamp, run id, job id, phase and number of `/epure continue` before it, the orchestrator jobs whose log GitHub did not serve (`usage.unavailable_job_logs`), the token usage EPURE wrote to `refs/epure/state` per EPURE phase (`state_usage`), Actions minutes from the durations of jobs that ran on a runner (skipped jobs have no runner, log or bill), escalations with their class, orchestrator job failures, `comparable`, and `evidence_error` when the runs could not be read.

A run passes when the feature PR to `dev` is open, no escalation is internal or unclassified, no ticket escalates twice, no orchestrator run fails, and at least one usage record exists with every orchestrator job log read (no record or a missing log means an unknown or incomplete cost, not $0), and the state's token usage per model equals the job-log totals (requests the state marks `usage_unavailable` print no log line and are left out), the agent App's Gate 3 comment shows the epic total and each ticket's usage with a cost, and the feature PR body's `epure-llm-usage` section shows the epic total with a cost and the state's request count. The harness resumes a first legitimate escalation per ticket with `/epure continue`. A run is `comparable` with another when it planned exactly 2 tickets, CI ran on at least one `task/*` branch, a task pull request got a review, and the host did not sleep more than a minute (`host_asleep_ms`: wall-clock time minus monotonic time; keep the machine awake and on power during a run). Cost comes from the `epure-llm-usage` line that `LLMClient` and the sandbox LLM proxy print right after the Actions timestamp for every LLM response with usage, read back from the orchestrator job logs.

Escalation classes (`tests/e2e/escalations.ts`): `internal` means EPURE or its configuration is at fault; `legitimate` means the work, a guard or an external system stopped the run as designed. `npm test` fails when EPURE gains a reason missing from this table.

| Reason | Class | Why |
| --- | --- | --- |
| `remediation_exhausted` | legitimate | The model could not make the task green within its fix attempts. |
| `epic_convergence_exhausted` | legitimate | The feature audit kept finding gaps. |
| `grace_window_timeout` | legitimate | External CI never reported the expected checks. |
| `sensitive_path_violation` | legitimate | The guard refused a change to a protected path. |
| `merge_conflict_unresolved` | legitimate | The model could not resolve a conflict with the feature branch. |
| `merge_conflict_stage1_failed` | legitimate | The conflict resolution broke the local checks. |
| `pr_not_mergeable` | legitimate | GitHub refused the merge. |
| `resync_verification_failed` | internal | Review or CI failed again right after EPURE resynced the task branch. |
| `wall_clock_budget_exhausted` | legitimate | The time budget ran out. |
| `transient_llm_api_exhausted` | legitimate | The provider kept failing. |
| `llm_quota_or_auth_failure` | legitimate | Provider quota or key. |
| `llm_request_invalid` | internal | The provider rejected EPURE's request, or its answer stayed malformed after corrective retries. |
| `llm_refusal` | legitimate | The model refused. |
| `model_config_missing` | internal | The configuration lacks a model EPURE needs. |
| `github_rate_limited` | legitimate | GitHub rate limit. |
| `branch_update_conflict` | internal | EPURE's own branch update conflicted. |
| `ambiguous_feature_branch` | internal | EPURE could not tell which feature branch is the plan's. |
| `plan_manifest_missing` | internal | The plan manifest is missing from the state and the comments. |
| `agent_timeout` | legitimate | An agent session ran past its time limit. |
| `agent_request_cap_reached` | legitimate | An agent session sent more LLM requests than its cap. |
| `agent_engine_failed` | internal | The agent engine failed to start, broke its protocol, or its sandbox or snapshot failed. |
| `sandbox_isolation_unavailable` | internal | The runner lacks the kernel confinement agent sessions require. |
| `agent_diff_too_large` | legitimate | An agent session changed more files or bytes than a commit accepts. |
| `agent_secret_leak_blocked` | legitimate | The guard found a secret in an agent session's files. |
| `agent_no_changes` | legitimate | The implementation session changed nothing. |
| `job_budget_exhausted` | legitimate | Too little job time remained to run an agent session. |
| `internal_error` | internal | Any other EPURE error. |
| `GLOSSARY_MISSING_FOR_DOMAIN_TERMS` | legitimate | Spec gate: the generated glossary is missing. |
| `ADR_MISSING_OR_INCOMPLETE` | legitimate | Spec gate: an ADR is missing or incomplete. |
| `SPEC_MISSING_OR_INCOMPLETE` | legitimate | Spec gate: the spec is missing or incomplete. |
| `TICKET_GRAPH_EMPTY` | legitimate | Ticket gate: the model planned no ticket. |
| `TICKET_GRAPH_CYCLE_DETECTED` | legitimate | Ticket gate: the tickets block each other in a cycle. |
| `UNPROVEN_BLOCKER_CLOSURE` | internal | Only a human closing a blocker as not planned triggers it, and the harness never does. |

### Semantic Versioning (`vMAJOR.MINOR.PATCH`)

Determine the next release tag strictly from the semantic content of the commits since the last tag (`fix:`/`refactor:`/`chore:` -> increment `PATCH`, e.g. `v1.5.9 -> v1.5.10`; `feat:` -> increment `MINOR`, e.g. `v1.5.9 -> v1.6.0`; `BREAKING CHANGE` / `!:` -> increment `MAJOR`). Never roll `.9` over to the next minor unless the release contains a `feat:`.


