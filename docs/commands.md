# Commands Reference (`/epure`, `/setup-repo` Skill & CLI)

EPURE is operated through two complementary surfaces:
1. **The local `/setup-repo` agent skill** (`.agents/skills/setup-repo/SKILL.md` — the **preferred way** to bootstrap or reconfigure a repository, its Rulesets, and its dynamic reviewer roster in `reviewers_dir`, default `.agents/reviewers/*.md`).
2. **GitHub Issue slash commands (`/epure ...`)** to drive the feature lifecycle day-to-day directly from GitHub Issues.

---

## 1. GitHub Issue Slash Commands (`/epure`)

All `/epure` commands are posted as comments on a GitHub Issue. Every command is guarded by a **Fail-Closed Permission Gate**: the commenter must hold `write` or `admin` repository permissions.

| Command | Category (Q101) | Target Phase | Description |
| --- | --- | --- | --- |
| `/epure plan` | <span class="epure-badge epure-badge--human">Mandatory Human Gate 1</span> | `grilling` | Initializes `refs/epure/state/<issue>`, inspects the repository via read-only exploration tools (`list_repo_files`, `read_repo_file`, `search_in_repo_file`), and starts the structured architectural Grill interview. |
| *(Any human comment during Grill)* | <span class="epure-badge epure-badge--human">Mandatory Human Gate 1</span> | `grilling` | Implicit Grill continuity (Q84): processes human answers via the batch cursor (`last_processed_comment_id`). If follow-up questions remain (`frontier_resolved: false`), posts the next Grill round. Once all ambiguities are settled (`frontier_resolved: true`), posts a **Settled Decisions Summary** and pauses in `grilling` (`awaiting_human_approval`) so the human validates the decision frontier before `/epure to-spec`. |
| `/epure to-spec` | <span class="epure-badge epure-badge--human">Human Frontier Validation</span> | `spec` | Validates the Grill decision frontier (or forces an early transition), runs the zero-context **Goldfish Specification Audit** (`runGoldfishSpecAudit`), and generates `GLOSSARY.md`, ADRs, `DESIGN.md`, and `docs/specs/<slug>.md` (including `EpicGoalContract`) on `plan/*`, then pauses in `spec` (`awaiting_human_approval`) for human review. Free-form comments during `spec` revise the specification on `plan/*`. |
| `/epure to-tickets` | <span class="epure-badge epure-badge--human">Human Spec Validation</span> | `tickets` | Validates the specification on `plan/*` and decomposes it into an acyclic dependency-ordered GitHub Issue DAG (`blocked_by`, `ready-for-agent`), wiring native GitHub relational graph links (`sub_issues` + `dependencies/blocked_by`) and pausing in `tickets` (`awaiting_human_approval`) before `/epure approve`. |
| `/epure approve` | <span class="epure-badge epure-badge--human">Mandatory Human Gate 2</span> | `implementation` | Integrates the approved `plan/*` artifacts (`GLOSSARY.md` additive merge, monotonic & semantic ADR collision reconciliation, `docs/specs/<slug>.md`, `DESIGN.md`) directly into `feature/<issue>-<slug>` without an intermediate `plan/* -> dev` PR (ADR-0031, ADR-0032), locks the signed `spec_sha` mandate in `refs/epure/state/<issue>`, and executes the ticket DAG (`task/* -> feature/*`). |
| `/epure continue` | <span class="epure-badge epure-badge--optional">Lifecycle Continuation</span> | `implementation` | Resumes orchestration after a `needs-human` suspension, after resolving a 3-way conflict, or after external CI (`waiting_ticket_ci` / `waiting_feature_ci`) completes (ADR-0031). |
| `/epure sync` (alias `/epure rebase`) | <span class="epure-badge epure-badge--optional">Git Branch Sync</span> | `implementation` | Synchronizes `dev -> feature/<issue>-<slug>` (and cascades `feature/* -> active_task_branch`) with additive `GLOSSARY.md` merging, monotonic ADR reconciliation, 3-way LLM conflict resolution, and **Stage 1 Sandbox** verification before committing (ADR-0031, ADR-0032). |
| `/epure status` | <span class="epure-badge epure-badge--optional">Optional Override</span> | *(Read-only)* | Reads `refs/epure/state/<issue>` and posts a fresh summary of the current phase, locked `spec_sha`, and per-ticket progress without mutating code. |
| `/epure cancel` (alias `/epure stop`) | <span class="epure-badge epure-badge--optional">Optional Override</span> | `cancelled` | Marks the mandate as `cancelled` in `refs/epure/state/<issue>`, stops any new ticket execution, and preserves existing branches and audit logs. |

> **Contextual `/epure` Command Cheat-Sheet Spoiler (`<details>`)**: Every issue comment, sub-issue body, and pull request description posted by EPURE automatically includes a collapsible `<details>` block at the bottom (`⌨️ Commandes /epure disponibles`) summarizing the available slash commands and highlighting the recommended next action for the current lifecycle phase (`grilling`, `spec`, `tickets`, `implementation`, `suspended`, `cancelled`, or `completed`).

---

## 2. End-to-End GitHub Actions & Custom Actions Pipeline (`epure-ci-actions-flow`)

<ArchifyDiagram
  slug="epure-ci-actions-flow"
  locale="en"
  title="EPURE GitHub Actions, Custom Actions & Event-Driven CI Pipeline"
  caption="End-to-end event pipeline connecting issue_comment, check_suite/workflow_run continuation, pull_request gates, and release workflow_dispatch across secretless and environment-scoped jobs."
/>

### How Commands & CI Events Flow Through `epure-issue-command.yml`

1. **Job 1 — Secretless Authorization Gate (`authorize-command` using `actions/authorize-command`)**:
   - Triggered on `issue_comment.created` using only `GITHUB_TOKEN` (`contents: read`, `issues: write`) and **zero agent or LLM secrets**.
   - Verifies that the commenter is a human with effective `write` or `admin` permission via `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.
   - With `allow_implicit_planning_reply: "true"`, free-text human comments without a slash prefix are automatically routed as `reply` commands whenever the issue is in the `grilling` or `spec` phase.
2. **Job 2 — Isolated Agent Orchestration (`orchestrate-command` using `actions/orchestrate-issue`)**:
   - Runs on `ubuntu-26.04` inside the dedicated GitHub Environment (`environment: <llm-env>`, default `epure-agent`; other examples: `llm`, `openai`, `anthropic`, or `gemini`) **only after** `authorize-command` succeeds (or upon an authorized CI continuation event).
   - Receives the environment-scoped secrets (`EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`, and `LLM_API_KEY` or provider key) and provisions the kernel sandbox tools (`bubblewrap`, `landrun`, `rtk`).
   - On `/epure to-tickets`, creates the child GitHub Issues and wires native GitHub relational graph links (`sub_issues` parent-child hierarchy + `dependencies/blocked_by` task edges).
3. **Automatic Event-Driven CI Continuation (`check_suite.completed` / `workflow_run.completed`)**:
   - When `async_ci_continuation: "true"` is enabled, opening a `task/* -> feature/*` PR (`waiting_ticket_ci`) or `feature/* -> dev` PR (`waiting_feature_ci`) records the active PR/SHA in `refs/epure/state/<issue>` and immediately exits `0` to free the GitHub Actions runner.
   - When external CI finishes on `task/*` or `feature/*`, the `check_suite.completed` or `workflow_run.completed` event wakes `orchestrate-command` with `command: "continue"`, `trigger_head_sha`, and `trigger_branch` to run Stage 3 multi-agent review, AI semantic squash, or unified auto-remediation.
4. **Pull Request Gates & Controlled Release Promotion**:
   - On `pull_request` events (`dev`, `main`, `feature/**`), `epure-check.yml` (`actions/epure-contract`), `pr-title.yml`, and `ci.yml` execute with `contents: read` and zero privileged secrets.
   - On human `workflow_dispatch`, `release.yml` runs inside the protected `environment: release` (`EPURE_RELEASE_APP_ID`, `EPURE_RELEASE_APP_PRIVATE_KEY`) via `actions/verify-app-role` to fast-forward `dev -> main`.

---

## 3. Repository Bootstrap Agent Skill (`/setup-repo` — Recommended)

The **`.agents/skills/setup-repo/SKILL.md`** skill is the **preferred way** to onboard or reconfigure an EPURE consumer repository from any Skills-compatible coding agent:

```text
/setup-repo <owner>/<repo>
```

### What the `/setup-repo` Skill Does

1. **Project Discovery**: Inspects the repository stack (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`), `src/` module layout, and whether a user interface is present.
2. **Dry-Run Simulation (`--dry-run`)**: Runs `dist/cli/setup-repo.mjs --dry-run` and presents the full plan to the human maintainer before writing anything.
3. **Dynamic Reviewer Roster Design (`reviewers_dir`, default `.agents/reviewers/*.md`)**: Creates, designs, and tailors specialist reviewers according to the project's actual elements (always-on core `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `user-advocate` + tailored domain/UI specialists with `paths:` routing).
4. **Idempotent Application (`--apply --apply-github-settings`)**: Writes `.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`, SHA-pinned caller workflows, configures squash-only merges, and provisions the 3 Repository Rulesets.

---

## 4. Underlying Bootstrap CLI (`dist/cli/setup-repo.mjs`)

Invoked automatically by the `/setup-repo` skill (or runnable directly from a terminal):

```bash
node dist/cli/setup-repo.mjs \
  --repo <owner>/<name> \
  --target-dir <path> \
  [--pinned-sha <40-char-sha>] \
  [--dry-run | --apply] \
  [--apply-github-settings] \
  [--no-frontend-reviewers] \
  [--domain-reviewers <slug1,slug2>] \
  [--reviewers-dir <path>] \
  [--llm-env <env-name>] \
  [--model <provider/model>] \
  [--planning-model <provider/model>] \
  [--implementation-model <provider/model>] \
  [--review-model <provider/model>] \
  [--agent-app-id <id>] \
  [--release-app-id <id>] \
  [--require-pr-approvals <N>] \
  [--json]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--repo <owner/name>` | *(Required)* | Target GitHub repository slug (e.g., `my-org/craft-calculator`). |
| `--target-dir <path>` (aliases `--dir`, `--repo-root`) | Current directory | Local checkout path where `.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`, workflows, and the reviewer prompts (`<reviewers_dir>/*.md`) are written. |
| `--pinned-sha <sha>` | Latest EPURE SHA | Immutable 40-character Git commit SHA of `Giskard-AI/epure` used to pin generated caller workflows. |
| `--dry-run` | `true` (if `--apply` omitted) | Prints the complete bootstrap plan without modifying local files or calling write APIs. |
| `--apply` | `false` | Writes configuration files (`.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`), caller workflows, and base reviewer prompts (`<reviewers_dir>/*.md`, default `.agents/reviewers/*.md`). |
| `--apply-github-settings` | `false` | Applies squash-only repository settings and the 3 Repository Rulesets via the GitHub REST API. |
| `--no-frontend-reviewers` | `false` | Omits `frontend-reviewer`, `accessibility-reviewer`, and `design-reviewer` for headless repositories. |
| `--domain-reviewers <csv>` | None | Scaffolds additional `<reviewers_dir>/<slug>-reviewer.md` specialist files for domain subsystems. |
| `--reviewers-dir <path>` | `.agents/reviewers` | Reviewer roster directory written to `.github/agents.yml` (`reviewers_dir`) and read by the orchestrator from `dev` (e.g. `--reviewers-dir .cursor/agents` for a team that wants Cursor to load the reviewers as subagents). Absolute paths, `.`/`..` segments, and paths under `src/` fail closed with `SECURITY_INVARIANT_VIOLATION`. |
| `--llm-env <env-name>` | `epure-agent` | GitHub Environment name (`[A-Za-z0-9._-]`) written to `.github/agents.yml` (`llm_environment`) and used by the `orchestrate-command` job of `.github/workflows/epure-issue-command.yml`. Must match the wizard's `--llm-env`. |
| `--model <provider/model>` | — | Sets `models.planning`, `models.implementation`, and `models.review` at once. |
| `--planning-model <provider/model>` | `anthropic/claude-sonnet-4-20250514` | Sets `models.planning`. |
| `--implementation-model <provider/model>` | `anthropic/claude-sonnet-4-20250514` | Sets `models.implementation`. |
| `--review-model <provider/model>` | `openai/gpt-4.1` | Sets `models.review`. |
| `--agent-app-id <id>` | Optional | Numeric GitHub App ID of `<owner>-epure-agent` added as PR Bypass Actor on `epure-feature-governance` (`feature/*`). |
| `--release-app-id <id>` | Optional | Numeric GitHub App ID of `<owner>-epure-release` added as sole Bypass Actor on `epure-release-immutability` (`main` and `v*`). |
| `--require-pr-approvals <N>` | `0` | Number of human PR review approvals required on `dev` (`0` for solo-maintainer compatibility; `>=1` for teams). |
| `--json` | `false` | Emits the full structured `SetupRepoResult` JSON payload to stdout instead of the Markdown summary. |

---

## 5. Interactive GitHub Apps Wizard (`setup-github-apps-wizard.sh`)

```bash
bash scripts/wizards/setup-github-apps-wizard.sh \
  --repo <owner>/<name> \
  --llm-env <env-name>
```

Guides a human maintainer through registering the two GitHub Apps (`<owner>-epure-agent` and `<owner>-epure-release`) via **Approach 2** (1-click local GitHub App Manifest flow) or **Fallback Approach 1** (manual step-by-step guided registration), creates the isolated GitHub Environments (`<llm-env>` — configurable and LLM-agnostic, default `epure-agent`; other examples: `llm`, `openai`, `anthropic`, `gemini` — and `release`), and uploads the 5 secrets to their respective environments (`EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`, and `LLM_API_KEY` in `--env <llm-env>`; `EPURE_RELEASE_APP_ID` and `EPURE_RELEASE_APP_PRIVATE_KEY` in `--env release`).
