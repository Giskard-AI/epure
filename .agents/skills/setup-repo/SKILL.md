---
name: setup-repo
description: Bootstrap or reconfigure an EPURE consumer repository with --dry-run simulation, .github/agents.yml defaults (Q78), squash-only merge governance, 3 Repository Rulesets (Q91/Q95), and a dynamically composed .cursor/agents/ multi-agent reviewer roster (Q92).
---

# `setup-repo` — Consumer Repository Bootstrap & Dynamic Roster Setup

Use this skill locally (via Cursor, Claude Code, Pi, or Codex) to inspect the target repository's stack and domains, simulate (`--dry-run`), and apply the EPURE consumer repository setup without duplicating resources on subsequent runs ([ADR-0010](../../../docs/adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md), [ADR-0023](../../../docs/adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0025](../../../docs/adr/0025-depot-public-epure-rulesets-et-tags-immuables.md), [ADR-0027](../../../docs/adr/0027-rulesets-roster-review-multi-agents-et-squash-ia.md)).

## Workflow

1. **Inspect Stack & Domain Architecture (Agent Discovery)**
   Before running the CLI, inspect the consumer repository (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `src/` directory layout, `GLOSSARY.md`) to determine:
   - Whether the repository includes a frontend / UI surface (or is a pure backend / CLI / library project).
   - Which domain subsystems warrant dedicated specialist reviewers beyond the default `domain-backend-reviewer` and `infra-reviewer` (for example: `realtime-reviewer`, `game-systems-reviewer`, `billing-reviewer`).

2. **Dry-Run Simulation (First Step)**
   Run the pre-bundled CLI in `--dry-run` mode to preview caller workflows pinned by 40-char SHA (including `.github/workflows/pr-title.yml`), `.github/agents.yml` defaults, the dynamically composed `.cursor/agents/*.md` reviewer roster, squash-only merge settings, and the 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`):
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --dir . --dry-run
   ```
   - Pass `--no-frontend-reviewers` if the repository has no UI surface (omits `frontend-reviewer`, `accessibility-reviewer`, and `design-reviewer`).
   - Pass `--domain-reviewers <slug1,slug2>` to generate additional domain-specific specialist reviewers in `.cursor/agents/`.

3. **Guided Application (Disk + GitHub API Governance + Dynamic Prompt Tailoring)**
   Write `.github/agents.yml`, caller workflows (`.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/pr-title.yml`, `.github/workflows/release.yml`), and `.cursor/agents/*.md` while applying squash-only repository settings and the 3 Repository Rulesets via the GitHub REST API:
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --dir . --apply --apply-github-settings
   ```
   - **Dynamic Reviewer Roster Design by the Agent (`.cursor/agents/*.md`)**:
     - **Always-On Core (Cross-Cutting & Persona)**: `architecture-reviewer.md`, `security-reviewer.md`, `spec-parity-reviewer.md`, `standards-reviewer.md` (automatically adapted to TypeScript/Node, Python, Rust, or Go), and `user-advocate.md`.
     - **Agent-Designed Domain & Stack Specialists**: After running `setup-repo.mjs`, the agent inspects the repository's actual modules (`src/`, database schemas, network/realtime engines, domain calculators, UI layers) and **creates, designs, or removes `.cursor/agents/<role>-reviewer.md` files** as needed.
     - Any custom specialist file added in `.cursor/agents/<slug>-reviewer.md` (with optional `paths: src/<sub-domain>` in its YAML frontmatter) is automatically discovered and selected by `selectReviewersForDiff` on PRs touching matching files.
   - Optional team flag: pass `--require-pr-approvals 1` to require an explicit GitHub approval review on `dev` (defaults to `0` for solo-maintainer compatibility while enforcing human merge in the GitHub UI).

4. **Human Confirmations & Secret Hygiene**
   - Register the two distinct GitHub Apps (**Agent App** and **Release App**) using `scripts/wizards/setup-github-apps-wizard.sh`.
   - Inject private keys locally via `gh secret set` — never paste PEM keys into issues, PRs, or prompts.
