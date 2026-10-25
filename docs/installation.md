# Installation & Bootstrap

The recommended way to initialize or reconfigure a repository with EPURE is to invoke the **`/setup-repo` agent skill** (`.agents/skills/setup-repo/SKILL.md`) directly inside your coding agent (Cursor, Claude Code, Pi, or Codex).

The `/setup-repo` skill orchestrates the entire bootstrap end-to-end: it inspects your repository's actual architecture, walks you through the interactive wizard (`setup-github-apps-wizard.sh`) to register your two GitHub Apps, runs the deterministic CLI (`dist/cli/setup-repo.mjs`) in `--dry-run` simulation mode before `--apply`, and **dynamically designs your multi-agent reviewer roster (`.cursor/agents/*.md`)**.

---

## System Requirements

Before bootstrapping a repository with EPURE, ensure your local environment has:

- **A Skills-compatible coding agent** (Cursor, Claude Code, Pi, or Codex) with `.agents/skills/setup-repo/SKILL.md`
- **Node.js 24 LTS** (`>=24.0.0`)
- **GitHub CLI (`gh`)** authenticated against your target GitHub account or organization (`gh auth status`)
- **Git** (`>=2.38`)
- **An LLM API Key** (`LLM_API_KEY` — defaults to Google Gemini `gemini-3.8-flash` with `thinking_level: HIGH`)

---

## Recommended Way: Bootstrap via the `/setup-repo` Skill

Open your target repository in your coding agent and invoke the **`/setup-repo`** skill:

```text
/setup-repo my-org/craft-calculator
```

The agent executes a guided **4-step workflow** with explicit human confirmation before any sensitive action:

### Step 1: Agent Inspection of Stack & Domain Elements

Before writing any file, the agent inspects the target repository (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `src/` directory layout, UI presence, existing `GLOSSARY.md`) to determine:

- The language and build stack to configure `.github/workflows/ci.yml`, Renovate, and `standards-reviewer.md`.
- Whether the repository includes a frontend/UI surface (which determines whether the **Impeccable** gate and `frontend-reviewer`, `accessibility-reviewer`, and `design-reviewer` are included).
- Which domain subsystems warrant creating **custom specialist reviewers** in `.cursor/agents/<domain>-reviewer.md`.

### Step 2: Provision the Two GitHub Apps & 5 Secrets (Wizard)

To enforce strict privilege separation (Q82, Q91), EPURE never uses a single all-powerful Personal Access Token. Instead, every repository or organization uses **two distinct GitHub Apps**:

1. **Agent App (`<owner>-epure-agent`)**: Used by the orchestrator for day-to-day automation (`plan/*`, `task/*`, `feature/*`, Issues, PRs, and Check Runs). It is **never** a Bypass Actor on `dev` or `main`.
2. **Release App (`<owner>-epure-release`)**: Used exclusively by `release-promote.yml` when a human triggers a fast-forward release from `dev` to `main`. It is the **sole Bypass Actor** on `main` and `v*` tags.

If the apps are not yet registered, the `/setup-repo` skill launches the interactive wizard (which uses the GitHub App Manifest flow and stores secrets via `gh secret set` without ever exposing PEM private keys to the LLM):

```bash
bash scripts/wizards/setup-github-apps-wizard.sh --repo my-org/craft-calculator
```

| Secret Name | Purpose |
| --- | --- |
| `LLM_API_KEY` | API key for the LLM proxy sidecar (kept out of the code execution sandbox). |
| `EPURE_AGENT_APP_ID` | Numeric App ID of `<owner>-epure-agent`. |
| `EPURE_AGENT_APP_PRIVATE_KEY` | PEM private key of `<owner>-epure-agent` (used to mint short-lived installation tokens). |
| `EPURE_RELEASE_APP_ID` | Numeric App ID of `<owner>-epure-release`. |
| `EPURE_RELEASE_APP_PRIVATE_KEY` | PEM private key of `<owner>-epure-release` (used only by `release-promote.yml`). |

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

---

## What the `/setup-repo` Skill Configures

1. **Branch Topology (`main` & `dev`)**:
   - Ensures both `main` (immutable release line) and `dev` (active integration branch) exist.
   - Sets **`dev` as the default branch** of the repository so Pull Requests target `dev` by default and `Closes #<issue>` trailers resolve automatically when landing on `dev`.
2. **Canonical Triage Labels**:
   - Creates or updates the 5 canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus orchestration labels (`needs-human`, `approved-sensitive-change`).
3. **Declarative Configuration & Thin Caller Workflows**:
   - Generates `.github/agents.yml` pinned to the latest immutable 40-character commit SHA of `Giskard-AI/epure`.
   - Installs `.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/pr-title.yml`, `.github/workflows/ci.yml` (tailored to the detected stack), and `.github/workflows/release.yml`.
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
