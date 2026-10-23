---
name: setup-repo
description: Bootstrap or reconfigure an EPURE consumer repository with --dry-run simulation, .github/agents.yml defaults (Q78), dual GitHub Apps, and immutable Release Rulesets (Q80).
---

# `setup-repo` — Consumer Repository Bootstrap & Reconfiguration

Use this skill locally to inspect, simulate (`--dry-run`), and apply the EPURE consumer repository setup without duplicating resources on subsequent runs ([ADR-0010](../../../docs/adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md), [ADR-0023](../../../docs/adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0025](../../../docs/adr/0025-depot-public-epure-rulesets-et-tags-immuables.md)).

## Workflow

1. **Dry-Run Simulation (First Step)**
   Run the pre-bundled CLI in `--dry-run` mode to preview caller workflows pinned by 40-char SHA, `.github/agents.yml` defaults, expected secrets, branch protections (`dev`, `feature/*`), and the `epure-release-immutability` Repository Ruleset on `main` & `refs/tags/v*`:
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --dir . --dry-run
   ```

2. **Guided Application**
   Write `.github/agents.yml` and caller workflows (`.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/release.yml`) while preserving idempotence:
   ```bash
   node dist/cli/setup-repo.mjs --repo <owner>/<repo> --dir . --apply
   ```

3. **Human Confirmations & Secret Hygiene**
   - Register the two distinct GitHub Apps (**Agent App** and **Release App**).
   - Inject private keys locally via `gh secret set` — never paste PEM keys into issues, PRs, or prompts.
   - Verify required CI checks and branch protections before enabling `task_auto_merge_enabled`.
