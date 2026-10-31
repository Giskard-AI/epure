# Installation & Bootstrap

The recommended way to initialize or reconfigure a repository with EPURE is to invoke the **`/setup-repo` agent skill** (`.agents/skills/setup-repo/SKILL.md`) directly inside your coding agent (Cursor, Claude Code, Pi, or Codex).

The `/setup-repo` skill orchestrates the entire bootstrap end-to-end: it inspects your repository's actual architecture, walks you through the interactive wizard (`setup-github-apps-wizard.sh`) to register your two GitHub Apps and isolated GitHub Environments (`<llm-env>` and `release`), runs the deterministic CLI (`dist/cli/setup-repo.mjs`) in `--dry-run` simulation mode before `--apply`, and **dynamically designs your multi-agent reviewer roster (`.cursor/agents/*.md`)**.

---

## System Requirements

Before bootstrapping a repository with EPURE, ensure your local environment has:

- **A Skills-compatible coding agent** (Cursor, Claude Code, Pi, or Codex) with `.agents/skills/setup-repo/SKILL.md`
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
- Which domain subsystems warrant creating **custom specialist reviewers** in `.cursor/agents/<domain>-reviewer.md`.

### Step 2: Provision the Two GitHub Apps & Environment-Scoped Secrets (Wizard)

To enforce strict privilege separation (Q82, Q91) and Zizmor-compliant zero secret exposure to unprivileged PR workflows, EPURE never uses a single all-powerful Personal Access Token or global repository secrets. Instead, every repository uses **two distinct GitHub Apps** and **two isolated GitHub Environments** (`<llm-env>` and `release`):

1. **Agent App (`<owner>-epure-agent`)**: Used by the orchestrator for day-to-day automation (`plan/*`, `task/*`, `feature/*`, Issues, PRs, and Check Runs). It is **never** a Bypass Actor on `dev` or `main`.
2. **Release App (`<owner>-epure-release`)**: Used exclusively by `release-promote.yml` / `release.yml` when a human triggers a fast-forward release from `dev` to `main`. It is the **sole Bypass Actor** on `main` and `v*` tags.

Launch the interactive wizard, which supports **Approach 2** (1-click local GitHub App Manifest Flow) with automatic **Fallback Approach 1** (manual step-by-step guided registration) and injects secrets into their dedicated GitHub Environments via `gh secret set --env` without ever exposing PEM private keys to the LLM:

```bash
bash scripts/wizards/setup-github-apps-wizard.sh \
  --repo my-org/craft-calculator \
  --llm-env <llm-env>
```

> **Configurable & LLM-Agnostic `<llm-env>`**: The agent environment name (`<llm-env>`) can be chosen freely (for example `epure-agent`, `llm`, `openai`, `anthropic`, or `gemini`) and matches `environment: <llm-env>` on the `orchestrate-command` job in `.github/workflows/epure-issue-command.yml`.

| Secret Name | GitHub Environment Scope | Purpose |
| --- | --- | --- |
| `LLM_API_KEY` | `--env <llm-env>` | API key for the LLM client / proxy sidecar (kept out of `authorize-command` and the code execution sandbox). |
| `EPURE_AGENT_APP_ID` | `--env <llm-env>` | Numeric App ID of `<owner>-epure-agent`. |
| `EPURE_AGENT_APP_PRIVATE_KEY` | `--env <llm-env>` | PEM private key of `<owner>-epure-agent` (used to mint short-lived installation tokens). |
| `EPURE_RELEASE_APP_ID` | `--env release` | Numeric App ID of `<owner>-epure-release` (bound to the human-approved `release` environment). |
| `EPURE_RELEASE_APP_PRIVATE_KEY` | `--env release` | PEM private key of `<owner>-epure-release` (used only by `release.yml` / `release-promote.yml`). |

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
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --dry-run
```

### Step 4: Guided Application (`--apply`) & Custom `.cursor/agents/` Design

Once you confirm the dry-run report, the `/setup-repo` skill applies the repository governance via `--apply --apply-github-settings`, and then creates and tailors the `.cursor/agents/*.md` reviewer prompts specific to your repository:

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /path/to/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --apply \
  --apply-github-settings
```

Then commit and push the generated files (`.github/`, `.cursor/agents/`, and `renovate.json`) to `dev`:

```bash
git add .github/ .cursor/agents/ renovate.json
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
4. **Dynamic Multi-Agent Reviewer Roster (`.cursor/agents/*.md`)**:
   - The agent running `/setup-repo` **creates, designs, and adds the appropriate `.cursor/agents/<role>-reviewer.md` files as needed** based on the repository's actual elements (further refined during `/epure plan`):
     - **Always-On Core (Cross-Cutting & Persona)**: `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer` (adapted to the detected language: TypeScript, Python, Rust, or Go), and `user-advocate`.
     - **Agent-Designed Stack, Domain & UI Specialists**: `domain-backend-reviewer`, `infra-reviewer`, any custom domain specialists designed by the agent for your subsystems (e.g. `realtime-reviewer.md`, `combat-engine-reviewer.md`, `sql-migration-reviewer.md` with YAML frontmatter `paths:` routing), and — only when the project includes a UI — the frontend/Impeccable trio (`frontend-reviewer`, `accessibility-reviewer`, `design-reviewer`).
     - *Illustrative example on `craft-calculator` (TypeScript + React web app)*: the agent composes a 10-reviewer roster combining the always-on core, `domain-backend-reviewer`, `infra-reviewer`, and the 3 UI/Impeccable reviewers.
5. **Squash-Only Merge Governance & 3 Repository Rulesets**:
   - Configures the repository to allow **Squash merge only** (`allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`).
   - Installs the 3 GitHub Repository Rulesets:
     - `epure-feature-governance` (`refs/heads/feature/*`): `Agent App` in PR bypass for autonomous `task/* -> feature/*` squash-merges once checks pass.
     - `epure-dev-governance` (`refs/heads/dev`): No `Agent App` bypass (`required_approving_review_count: 0` by default for solo-maintainer compatibility; configurable via `--require-pr-approvals <N>`).
     - `epure-release-immutability` (`refs/heads/main`, `refs/tags/v*`): `Release App` as sole Bypass Actor.
