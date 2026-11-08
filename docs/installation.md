# Installation & Bootstrap

The recommended way to initialize or reconfigure a repository with EPURE is to invoke the **`/setup-repo` agent skill** (`.agents/skills/setup-repo/SKILL.md`) directly inside your Skills-compatible coding agent.

The `/setup-repo` skill orchestrates the entire bootstrap end-to-end: it inspects your repository's actual architecture, walks you through the interactive wizard (`setup-github-apps-wizard.sh`) to register your two GitHub Apps and isolated GitHub Environments (`<llm-env>` and `release`), runs the deterministic CLI (`dist/cli/setup-repo.mjs`) in `--dry-run` simulation mode before `--apply`, and **dynamically designs your multi-agent reviewer roster (`reviewers_dir`, default `.agents/reviewers/*.md`)**.

---

## System Requirements

Before bootstrapping a repository with EPURE, ensure your local environment has:

- **A Skills-compatible coding agent** (any IDE or CLI agent that can load `.agents/skills/setup-repo/SKILL.md`)
- **Node.js 24 LTS** (`>=24.0.0`)
- **GitHub CLI (`gh`)** authenticated against your target GitHub account or organization (`gh auth status`)
- **Git** (`>=2.38`)
- **An LLM API Key** (`LLM_API_KEY` or custom provider key configured in `.github/agents.yml`)

---

## Recommended Way: Bootstrap via the `/setup-repo` Skill

Open your target repository in your coding agent and invoke the **`/setup-repo`** skill:

```text
/setup-repo my-org/craft-calculator
```

The agent executes a guided **4-step workflow** with explicit human confirmation before any sensitive action:

### Step 1: Agent Inspection of Stack & Domain Elements

Before writing any file, the agent inspects the target repository (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `src/` directory layout, UI presence, existing `GLOSSARY.md`) to determine:

- The language and build stack to configure `.github/workflows/ci.yml`, `verification.targets`, `renovate.json`, `.github/zizmor.yml`, and `standards-reviewer.md`.
- Whether the repository includes a frontend/UI surface (which determines whether the **Impeccable** gate and `frontend-reviewer`, `accessibility-reviewer`, and `design-reviewer` are included).
- Which domain subsystems warrant creating **custom specialist reviewers** in `.agents/reviewers/<domain>-reviewer.md` (or your configured `reviewers_dir`).

### Step 2: Provision the Two GitHub Apps & Environment-Scoped Secrets (Wizard)

To enforce strict privilege separation (Q82, Q91) and Zizmor-compliant zero secret exposure to unprivileged PR workflows, EPURE never uses a single all-powerful Personal Access Token or global repository secrets. Instead, every repository uses **two distinct GitHub Apps** and **two isolated GitHub Environments** (`<llm-env>` and `release`):

1. **Agent App (`<owner>-epure-agent`)**: Used by the orchestrator for day-to-day automation (`plan/*`, `task/*`, `feature/*`, Issues, PRs, and Check Runs). It is **never** a Bypass Actor on `dev` or `main`.
2. **Release App (`<owner>-epure-release`)**: Used exclusively by the release workflow (your `.github/workflows/release.yml`, which calls EPURE's reusable `release-promote.yml`) when a human dispatches a fast-forward release from `dev` to `main` with `semver_tag` and `expected_dev_sha`. It is the **sole Bypass Actor** on `epure-release-immutability` (`main`) and `epure-release-tags` (`v*` tags). See [Promote a Release](./guides/how-to-release.md) for the one-time environment protection (required reviewer, `dev`-only deployment branch policy).

Launch the interactive wizard, which supports **Approach 2** (1-click local GitHub App Manifest Flow) with automatic **Fallback Approach 1** (manual step-by-step guided registration) and injects secrets into their dedicated GitHub Environments via `gh secret set --env` without ever exposing PEM private keys to the LLM:

```bash
bash scripts/wizards/setup-github-apps-wizard.sh \
  --repo my-org/craft-calculator \
  --llm-env <llm-env>
```

> **Configurable & LLM-Agnostic `<llm-env>`**: The agent environment name (`<llm-env>`) defaults to `epure-agent` and can be chosen freely (other examples: `llm`, `openai`, `anthropic`, or `gemini`; pass the same value to `setup-repo --llm-env`) and matches `environment: <llm-env>` on the `orchestrate-command` job in `.github/workflows/epure-issue-command.yml`.

| Secret Name | GitHub Environment Scope | Purpose |
| --- | --- | --- |
| `LLM_API_KEY` | `--env <llm-env>` | API key for the LLM client / proxy sidecar (kept out of `authorize-command` and the code execution sandbox). |
| `EPURE_AGENT_APP_ID` | `--env <llm-env>` | Numeric App ID of `<owner>-epure-agent`. |
| `EPURE_AGENT_APP_PRIVATE_KEY` | `--env <llm-env>` | PEM private key of `<owner>-epure-agent` (used to mint short-lived installation tokens). |
| `EPURE_RELEASE_APP_ID` | `--env release` | Numeric App ID of `<owner>-epure-release` (bound to the human-approved `release` environment). |
| `EPURE_RELEASE_APP_PRIVATE_KEY` | `--env release` | PEM private key of `<owner>-epure-release` (passed by `release.yml` to `release-promote.yml` only). |

Verify the environment-scoped secrets with `gh`:

```bash
gh secret list -R my-org/craft-calculator --env <llm-env>
gh secret list -R my-org/craft-calculator --env release
```

### Step 3: Non-Destructive Simulation (`--dry-run`)

The `/setup-repo` skill first runs the underlying CLI in `--dry-run` mode and presents the complete file, branch, label, and ruleset plan for your approval:

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /path/to/craft-calculator \
  --pinned-sha "$(git -C /path/to/epure rev-parse HEAD)" \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --dry-run
```

### Step 4: Guided Application (`--apply`) & Custom Reviewer Roster Design

Once you confirm the dry-run report, the `/setup-repo` skill applies the repository governance via `--apply --apply-github-settings`, and then creates and tailors the reviewer prompts in `.agents/reviewers/*.md` (or the directory chosen with `--reviewers-dir`) specific to your repository:

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /path/to/craft-calculator \
  --pinned-sha "$(git -C /path/to/epure rev-parse HEAD)" \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --apply \
  --apply-github-settings
```

Then commit and push the generated files (`.github/`, `.agents/reviewers/`, and `renovate.json`) to `dev`:

```bash
git add .github/ .agents/reviewers/ renovate.json
git commit -m "chore(epure): bootstrap repository governance and workflows"
git push origin dev
```

---

## What the `/setup-repo` Skill Configures

1. **Branch Topology (`main` & `dev`)**:
   - Ensures both `main` (immutable release line) and `dev` (active integration branch) exist.
   - Sets **`dev` as the default branch** of the repository so Pull Requests target `dev` by default and `Closes #<issue>` trailers resolve automatically when landing on `dev`.
2. **Canonical Triage Labels**:
   - Creates or updates the 5 canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus orchestration labels (`needs-human`, `approved-sensitive-change`).
3. **Declarative Configuration, Hardened Supply-Chain & Thin Caller Workflows**:
   - Generates `.github/agents.yml` (flat canonical schema with auto-discovered `verification.targets`), `.github/zizmor.yml` (static workflow security configuration), and `renovate.json` (with 3-to-14-day quarantine cooldowns).
   - Installs `.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/pr-title.yml`, `.github/workflows/ci.yml` (tailored to the detected stack), and `.github/workflows/release.yml`, all pinned to the 40-character commit SHA of `Giskard-AI/epure`.
4. **Dynamic Multi-Agent Reviewer Roster (`reviewers_dir`, default `.agents/reviewers/*.md`)**:
   - The agent running `/setup-repo` **creates, designs, and adds the appropriate `<reviewers_dir>/<role>-reviewer.md` files as needed** based on the repository's actual elements (further refined during `/epure plan`):
     - **Always-On Core (Cross-Cutting & Persona)**: `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer` (adapted to the detected language: TypeScript, Python, Rust, or Go), and `user-advocate`.
     - **Agent-Designed Stack, Domain & UI Specialists**: `domain-backend-reviewer`, `infra-reviewer`, any custom domain specialists designed by the agent for your subsystems (e.g. `realtime-reviewer.md`, `combat-engine-reviewer.md`, `sql-migration-reviewer.md` with YAML frontmatter `paths:` routing), and — only when the project includes a UI — the frontend/Impeccable trio (`frontend-reviewer`, `accessibility-reviewer`, `design-reviewer`).
     - *Illustrative example on `craft-calculator` (TypeScript + React web app)*: the agent composes a 10-reviewer roster combining the always-on core, `domain-backend-reviewer`, `infra-reviewer`, and the 3 UI/Impeccable reviewers.
5. **Squash-Only Merge Governance & 5 Repository Rulesets**:
   - Configures the repository to allow **Squash merge only** (`allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`).
   - Installs the 5 GitHub Repository Rulesets:
     - `epure-feature-integrity` (`refs/heads/feature/*`): blocks deletion and force-push with no bypass actor, so not even the `Agent App` can rewrite or delete a feature branch. Consequence: merged `feature/*` branches stay on GitHub. `delete_branch_on_merge` cannot remove them and neither can an admin; to prune them, temporarily disable this ruleset (Settings → Rules → Rulesets), delete the merged branches, then re-enable it.
     - `epure-feature-governance` (`refs/heads/feature/*`): `Agent App` in `always` bypass for autonomous `task/* -> feature/*` squash-merges once checks pass and for EPURE's direct writes (plan integration, `dev` merge syncs, conflict resolutions); humans still go through PRs.
     - `epure-dev-governance` (`refs/heads/dev`): No `Agent App` bypass (`required_approving_review_count: 0` by default for solo-maintainer compatibility; configurable via `--require-pr-approvals <N>`).
     - Both `epure-feature-governance` and `epure-dev-governance` require the checks of the generated workflows before a merge: `Verify EPURE Consumer Contract / Verify EPURE Consumer Contract`, `PR title`, `Quality (Format, Lint, Typecheck, Test & Build)` and `Zizmor`. Only a check run from GitHub Actions counts: a result of the same name from another App (EPURE's own `PR title` check run) or from a personal token does not. This does not protect against the PR's own content: `pull_request` runs the workflows of the PR's merge commit, so a PR that edits or adds a workflow, or changes `package.json` or the test configuration that `Quality` runs, can turn these checks green itself. To cover that case, put `.github/workflows/**`, `package.json` and your test configuration under `CODEOWNERS` and require code owner review in a ruleset of your own on `dev` (when `setup-repo` updates `epure-dev-governance`, it resets changes made to it), or use organization required workflows. `ai-review` is not required: only EPURE publishes it, so it never reports on a Renovate or human PR. A PR does not have to be up to date with its base branch, and creating a branch skips the checks. The `Agent App` bypasses these checks on `feature/*` only. Re-running `--apply-github-settings` updates rulesets created by an earlier version in place.
     - `epure-release-immutability` (`refs/heads/main`): no update (PR merges included), direct push, force-push or deletion; `Release App` as sole Bypass Actor, so only a release moves `main`. An urgent manual hotfix on `main` requires an admin to disable this ruleset temporarily.
     - `epure-release-tags` (`refs/tags/v*`, a tag ruleset): no creation, move or deletion of `v*` tags; `Release App` as sole Bypass Actor.

## Fail-Closed Trade-Offs

- **Resume guidance from maintainers with private organization membership**: when `/epure continue` or `/epure approve` resumes an implementation, EPURE forwards recent comments from `write`-or-higher contributors to the resumed session. To keep visitors from spending the permission lookups, it only looks up authors whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. GitHub reports an organization member whose membership is private as `CONTRIBUTOR` or `NONE`, so that maintainer's comments are dropped from the resume context even though they hold `write`. Commands are not affected: every `/epure` command is still authorized by the effective permission. Make the membership public (organization → People), or add the maintainer as a direct collaborator, to have their guidance forwarded.
