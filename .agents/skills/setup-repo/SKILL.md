---
name: setup-repo
description: Bootstrap or reconfigure an EPURE consumer repository with --dry-run simulation, .github/agents.yml defaults (Q78), squash-only merge governance, 3 Repository Rulesets (Q91/Q95), and the .cursor/agents/ multi-agent reviewer roster (Q92).
---

# `setup-repo` — Consumer Repository Bootstrap & Reconfiguration

Use this skill locally to inspect, simulate (`--dry-run`), and apply the EPURE consumer repository setup without duplicating resources on subsequent runs ([ADR-0010](../../../docs/adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md), [ADR-0023](../../../docs/adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0025](../../../docs/adr/0025-depot-public-epure-rulesets-et-tags-immuables.md), [ADR-0027](../../../docs/adr/0027-rulesets-roster-review-multi-agents-et-squash-ia.md)).

## Workflow

1. **Dry-Run Simulation (First Step)**
   Run the pre-bundled CLI in `--dry-run` mode to preview caller workflows pinned by 40-char SHA (including `.github/workflows/pr-title.yml`), `.github/agents.yml` defaults, the 10-agent `.cursor/agents/*.md` reviewer roster, squash-only merge settings, and the 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`):
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --dir . --dry-run
   ```

2. **Guided Application (Disk + GitHub API Governance)**
   Write `.github/agents.yml`, caller workflows (`.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/pr-title.yml`, `.github/workflows/release.yml`), and `.cursor/agents/*.md` while applying squash-only repository settings and the 3 Repository Rulesets via the GitHub REST API:
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --dir . --apply --apply-github-settings
   ```
   Optional team flag: pass `--require-pr-approvals 1` to require an explicit GitHub approval review on `dev` (defaults to `0` for solo-maintainer compatibility while enforcing human merge in the GitHub UI).

3. **Human Confirmations & Secret Hygiene**
   - Register the two distinct GitHub Apps (**Agent App** and **Release App**) using `scripts/setup-github-apps-wizard.sh`.
   - Inject private keys locally via `gh secret set` — never paste PEM keys into issues, PRs, or prompts.
