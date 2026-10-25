# How-To: Onboard a Repository with the `/setup-repo` Skill

This guide shows how to take a brand-new or existing GitHub repository (such as `my-org/craft-calculator`) and onboard it by invoking **the `/setup-repo` agent skill** (`.agents/skills/setup-repo/SKILL.md`)—the preferred way to configure EPURE's 2 GitHub Apps, 5 secrets, `.github/agents.yml`, dynamic `.cursor/agents/*.md` reviewer roster, and 3 Repository Rulesets.

---

## 1. Create the Two GitHub Apps & Repository Secrets

EPURE separates day-to-day agent privileges from production release privileges using two GitHub Apps:

- **`<owner>-epure-agent`**: Permissions `contents: write`, `issues: write`, `pull_requests: write`, `checks: write`.
- **`<owner>-epure-release`**: Permissions `contents: write`, `metadata: read`.

Run the interactive wizard (or let the `/setup-repo` skill prompt you to run it):

```bash
bash scripts/wizards/setup-github-apps-wizard.sh --repo my-org/craft-calculator
```

Verify that all 5 secrets are registered on your target repository:

```bash
gh secret list -R my-org/craft-calculator
```

Expected output:

```text
EPURE_AGENT_APP_ID
EPURE_AGENT_APP_PRIVATE_KEY
EPURE_RELEASE_APP_ID
EPURE_RELEASE_APP_PRIVATE_KEY
LLM_API_KEY
```

---

## 2. Invoke the `/setup-repo` Skill (Inspection & `--dry-run` Simulation)

Inside your coding agent (Cursor, Claude Code, Pi, or Codex), invoke the **`/setup-repo`** skill on the target repository:

```text
/setup-repo my-org/craft-calculator
```

The agent inspects the repository's elements (language, build scripts, UI presence, sub-domains in `src/`) and first runs the CLI in `--dry-run` mode:

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /path/to/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --dry-run
```

Check that the dry-run report presented by the agent lists:

- Creation of `.github/agents.yml` pinned to the 40-character SHA of `Giskard-AI/epure`.
- Creation of `.github/workflows/epure-issue-command.yml`, `epure-check.yml`, `pr-title.yml`, `ci.yml`, and `release.yml`.
- Dynamic initialization of the `.cursor/agents/*.md` reviewer roster designed by the agent for your stack and sub-domains (always-on core `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `user-advocate` + tailored domain/UI specialists, yielding 10 agents for the `craft-calculator` web app example).
- Creation of the 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`).

---

## 3. Confirm Application (`--apply`) & Commit to `dev`

Once you confirm, the `/setup-repo` skill runs `--apply --apply-github-settings` and tailors the `.cursor/agents/<role>-reviewer.md` definitions to your domain modules:

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /path/to/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --apply \
  --apply-github-settings
```

Then commit and push the generated files to `dev`:

```bash
cd /path/to/craft-calculator
git checkout dev
git add .github/ .cursor/agents/
git commit -m "chore(epure): bootstrap repository governance and workflows"
git push origin dev
```

---

## 4. Solo Maintainer vs. Team Mode (`--require-pr-approvals`)

- **Solo Maintainer (Default `--require-pr-approvals 0`)**: GitHub does not allow a user to approve their own Pull Request. Setting `required_approving_review_count: 0` on `epure-dev-governance` ensures you can click **Squash and merge** on `feature/* -> dev` PRs opened by EPURE while still blocking the `Agent App` from self-merging.
- **Multi-Maintainer Team (`--require-pr-approvals 1` or higher)**: Require at least one peer human approval in addition to green `verify-contract` and `ai-review` checks before merging into `dev`.
