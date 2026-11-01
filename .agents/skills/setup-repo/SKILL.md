---
name: setup-repo
description: Bootstrap or reconfigure an EPURE consumer repository with --dry-run simulation, .github/agents.yml defaults (Q78), squash-only merge governance, 3 Repository Rulesets (Q91/Q95), and a dynamically composed multi-agent reviewer roster in reviewers_dir (default .agents/reviewers/, Q92).
---

# `setup-repo` — Consumer Repository Bootstrap & Dynamic Roster Setup

Use this skill locally from any Skills-compatible coding agent (e.g. Cursor, Claude Code, Pi, or Codex) to inspect the target repository's stack and domains, simulate (`--dry-run`), and apply the EPURE consumer repository setup without duplicating resources on subsequent runs ([ADR-0010](../../../docs/adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md), [ADR-0023](../../../docs/adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0025](../../../docs/adr/0025-depot-public-epure-rulesets-et-tags-immuables.md), [ADR-0027](../../../docs/adr/0027-rulesets-roster-review-multi-agents-et-squash-ia.md)).

## Generated Repository Artifacts (18 Files by Default)

Running `setup-repo` scaffolds **18 files** on a standard full-stack repository (or 15 when `--no-frontend-reviewers` is passed):

1. **Declarative Orchestrator & Security Configuration (3 files)**:
   - `.github/agents.yml`: Harness (`pi` or `codex`), `models` (`planning`, `implementation`, `review`; defaults `anthropic/claude-sonnet-4-20250514`, `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4.1`), `reviewers_dir` (default `.agents/reviewers`), `llm_environment` (default `epure-agent`), optional `providers` (`os.environ/...`), polyglot `verification.targets` + `deferred_external_workflows`, `web_tools`, and non-weakenable `security_invariants`.
   - `.github/zizmor.yml`: Zizmor static analysis configuration enforcing `dangerous-triggers` and least-privilege workflow auditing.
   - `renovate.json`: Hardened Renovate configuration targeting `dev`, pinning GitHub Action digests, disabling post-install scripts (`ignore-scripts=true`), and enforcing 3-to-14-day quarantine cooldowns (`minimumReleaseAge`).
2. **Caller Workflows Pinned by 40-Character Commit SHA (5 files)**:
   - `.github/workflows/epure-issue-command.yml`: Two-job `/epure` gate (`authorize-command` -> `orchestrate-command` bound to `environment: <llm-env>`).
   - `.github/workflows/epure-check.yml`: Consumer contract & strict 40-char SHA pinning verification on PRs targeting `dev`, `main`, and `feature/**`.
   - `.github/workflows/pr-title.yml`: Conventional Commit PR title check (`PR title`).
   - `.github/workflows/ci.yml`: Stack-aware quality gate (`Quality (Format, Lint, Typecheck, Test & Build)` + pedantic `Zizmor` scan on `ubuntu-26.04`).
   - `.github/workflows/release.yml`: Controlled release promotion (`dev -> main` + `vMAJOR.MINOR.PATCH` tags) isolated inside `environment: release`.
3. **Multi-Agent Reviewer Roster (10 files by default in `.agents/reviewers/*.md`, or `<reviewers_dir>/*.md` with `--reviewers-dir`)**:
   - Always-on core (5): `architecture-reviewer.md`, `security-reviewer.md`, `spec-parity-reviewer.md`, `standards-reviewer.md`, `user-advocate.md`.
   - Stack & domain specialists (2+): `domain-backend-reviewer.md`, `infra-reviewer.md` (plus any custom `--domain-reviewers <list>`).
   - Frontend / Impeccable specialists (3, omitted with `--no-frontend-reviewers`): `frontend-reviewer.md`, `accessibility-reviewer.md`, `design-reviewer.md`.

## CLI Reference (`dist/cli/setup-repo.mjs`)

| Flag | Description |
| :--- | :--- |
| `--repo <owner/repo>` | **(Required)** Target GitHub repository slug (e.g., `acme-org/payments`). |
| `--dir <path>` / `--target-dir <path>` | Target repository checkout directory where the 18 files are planned/written (alias: `--repo-root <path>`). |
| `--dry-run` | Default mode; previews all planned files, discovered `verification.targets`, and 3 Repository Rulesets without mutating disk or calling write APIs. |
| `--apply` | Writes `.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`, the 5 caller workflows, and `<reviewers_dir>/*.md` to disk (idempotent `noop` on unchanged files). |
| `--apply-github-settings` | Applies squash-only merge settings (`allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`) and creates/updates the 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`) via the GitHub REST API. |
| `--agent-app-id <id>` | Numeric GitHub App ID of `<owner>-epure-agent`, wired as PR Bypass Actor on `epure-feature-governance` (`refs/heads/feature/*`). |
| `--release-app-id <id>` | Numeric GitHub App ID of `<owner>-epure-release`, wired as sole `always` Bypass Actor on `epure-release-immutability` (`refs/heads/main`, `refs/tags/v*`). |
| `--pinned-sha <40-char-sha>` | Overrides the 40-character commit SHA of `Giskard-AI/epure` used to pin reusable workflows and actions. |
| `--require-pr-approvals <count>` | Number of required human PR approvals on `epure-dev-governance` (`0` by default for solo-maintainer compatibility; set `>=1` for teams). |
| `--no-frontend-reviewers` | Omits `frontend-reviewer.md`, `accessibility-reviewer.md`, and `design-reviewer.md` for headless / backend-only repositories. |
| `--domain-reviewers <list>` | Comma-separated list of custom domain specialist slugs (e.g., `realtime,billing`) to scaffold in `<reviewers_dir>/<slug>-reviewer.md`. |
| `--reviewers-dir <path>` | Reviewer roster directory (default `.agents/reviewers`), written to `.github/agents.yml` as `reviewers_dir` and read by the orchestrator from `dev`. Example: `--reviewers-dir .cursor/agents` so Cursor also loads the reviewers as subagents. Absolute paths, `.`/`..` segments, and paths under `src/` fail closed with `SECURITY_INVARIANT_VIOLATION`. |
| `--llm-env <name>` | GitHub Environment name for the `orchestrate-command` job (default `epure-agent`, characters `[A-Za-z0-9._-]`), written as `llm_environment`. Must match the wizard's `--llm-env`. |
| `--model <provider/model>` | Sets `models.planning`, `models.implementation`, and `models.review` at once. |
| `--planning-model <provider/model>` | Sets `models.planning` (default `anthropic/claude-sonnet-4-20250514`). |
| `--implementation-model <provider/model>` | Sets `models.implementation` (default `anthropic/claude-sonnet-4-20250514`). |
| `--review-model <provider/model>` | Sets `models.review` (default `openai/gpt-4.1`). |
| `--json` | Emits the full structured `SetupRepoResult` payload as JSON instead of Markdown. |

## Workflow

1. **Inspect Stack, Verification Targets & LLM Providers (Agent Discovery)**
   Before running the CLI, inspect the consumer repository (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `src/` directory layout, `GLOSSARY.md`) to determine:
   - Whether the repository includes a frontend / UI surface (or is a pure backend / CLI / library project).
   - Which domain subsystems warrant dedicated specialist reviewers beyond the default `domain-backend-reviewer` and `infra-reviewer` (for example: `realtime-reviewer`, `game-systems-reviewer`, `billing-reviewer`).
   - **Polyglot `verification.targets` & Two-Stage Verification**:
     - Inspect the discovered `verification.targets` in `.github/agents.yml` (each target specifies `name`, `kind`, `working_directory`, `path_patterns`, and **Stage 1** in-sandbox commands: `install_command`, `codegen_command`, `typecheck_command`, `lint_command`, `test_command`, `build_command`).
     - Verify **Stage 2** external CI settings (`wait_for_external_ci`, `external_ci_timeout_minutes`, `grace_window_seconds`, and `deferred_external_workflows` for heavy/slow workflows deferred until PR review).
   - **Models & Custom LLM `providers` (`os.environ/...`)**:
     - Inspect `models` (`planning`, `implementation`, `review`) and optional `providers` aliases in `.github/agents.yml`. API keys in `providers.<alias>.api_key` must use `os.environ/<SECRET_NAME>` references (never literal secrets) resolved by the runner-local LLM proxy sidecar.

2. **Dry-Run Simulation (First Step)**
   Run the pre-bundled CLI in `--dry-run` mode to preview caller workflows pinned by 40-char SHA (including `.github/workflows/pr-title.yml`, `.github/workflows/ci.yml`, `.github/zizmor.yml`, and `renovate.json`), `.github/agents.yml` defaults, the dynamically composed `<reviewers_dir>/*.md` reviewer roster, squash-only merge settings, and the 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`):
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --target-dir . --dry-run
   ```
   - Pass `--no-frontend-reviewers` if the repository has no UI surface (omits `frontend-reviewer`, `accessibility-reviewer`, and `design-reviewer`).
   - Pass `--domain-reviewers <slug1,slug2>` to generate additional domain-specific specialist reviewers in `<reviewers_dir>/`.
   - Pass `--reviewers-dir <path>` only if the team wants the roster outside `.agents/reviewers` (e.g. `.cursor/agents`), `--llm-env <name>` if the agent GitHub Environment is not `epure-agent`, and `--model` / `--planning-model` / `--implementation-model` / `--review-model` to pick the team's LLM provider.

3. **Guided Application (Disk + GitHub API Governance + Dynamic Prompt Tailoring)**
   Write `.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`, caller workflows (`.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/pr-title.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`), and `<reviewers_dir>/*.md` while applying squash-only repository settings and the 3 Repository Rulesets via the GitHub REST API:
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --target-dir . --agent-app-id <agent-id> --release-app-id <release-id> --apply --apply-github-settings
   ```
   - **Dynamic Reviewer Roster Design by the Agent (`<reviewers_dir>/*.md`, default `.agents/reviewers/*.md`)**:
     - **Always-On Core (Cross-Cutting & Persona)**: `architecture-reviewer.md`, `security-reviewer.md`, `spec-parity-reviewer.md`, `standards-reviewer.md` (automatically adapted to TypeScript/Node, Python, Rust, or Go), and `user-advocate.md`.
     - **Agent-Designed Domain & Stack Specialists**: After running `setup-repo.mjs`, the agent inspects the repository's actual modules (`src/`, database schemas, network/realtime engines, domain calculators, UI layers) and **creates, designs, or removes `<reviewers_dir>/<role>-reviewer.md` files** as needed.
     - Any custom specialist file added in `<reviewers_dir>/<slug>-reviewer.md` (with optional `paths: src/<sub-domain>` in its YAML frontmatter) is automatically discovered and selected by `selectReviewersForDiff` on PRs touching matching files.
   - Optional team flag: pass `--require-pr-approvals 1` to require an explicit GitHub approval review on `dev` (defaults to `0` for solo-maintainer compatibility while enforcing human merge in the GitHub UI).

4. **Human Confirmations & Secret Hygiene (Zizmor GitHub Environment Scoping)**
   - Register the two distinct GitHub Apps (**Agent App** `<owner>-epure-agent` and **Release App** `<owner>-epure-release`) and provision environment-scoped secrets using the interactive 5-stage wizard (supports 1-click GitHub App Manifest Flow via local callback server plus `--manual` guided fallback):
     ```bash
     bash scripts/wizards/setup-github-apps-wizard.sh --repo <owner>/<repo> --llm-env <llm-env>
     ```
   - **Zizmor-Compliant GitHub Environment Secret Isolation**:
     - **Execution Environment `--env <llm-env>`** (LLM-agnostic name, default `epure-agent`; other examples: `llm`, `openai`, `anthropic`, or `gemini`; must match `llm_environment` / `setup-repo --llm-env` and therefore `environment:` in `.github/workflows/epure-issue-command.yml`): holds `EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`, and `LLM_API_KEY` (plus optional provider-specific secrets such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`, `AZURE_AI_API_KEY` via `gh secret set <NAME> -R <owner>/<repo> --env <llm-env>`). This ensures untrusted `issue_comment` triggers never access secrets before `authorize-command` succeeds.
     - **Protected `release` Environment (`--env release`)**: holds `EPURE_RELEASE_APP_ID` and `EPURE_RELEASE_APP_PRIVATE_KEY` (`gh secret set <NAME> -R <owner>/<repo> --env release`), accessible exclusively to `.github/workflows/release.yml` on human `workflow_dispatch`.
   - Inject private keys locally via the wizard or `gh secret set` — never write PEM keys to repo files or paste them into issues, PRs, or prompts.
