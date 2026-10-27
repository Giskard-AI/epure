# Commands Reference (`/epure`, `/setup-repo` Skill & CLI)

EPURE is operated through two complementary surfaces:
1. **The local `/setup-repo` agent skill** (`.agents/skills/setup-repo/SKILL.md` — the **preferred way** to bootstrap or reconfigure a repository, its Rulesets, and its dynamic `.cursor/agents/*.md` reviewer roster).
2. **GitHub Issue slash commands (`/epure ...`)** to drive the feature lifecycle day-to-day directly from GitHub Issues.

---

## 1. GitHub Issue Slash Commands (`/epure`)

All `/epure` commands are posted as comments on a GitHub Issue. Every command is guarded by a **Fail-Closed Permission Gate**: the commenter must hold `write` or `admin` repository permissions.

| Command | Category (Q101) | Target Phase | Description |
| --- | --- | --- | --- |
| `/epure plan` | <span class="epure-badge epure-badge--human">Mandatory Human Gate 1</span> | `grilling` | Initializes `refs/epure/state/<issue>`, inspects the repository, and starts the structured architectural Grill interview. |
| *(Any human comment during Grill)* | <span class="epure-badge epure-badge--human">Mandatory Human Gate 1</span> | `grilling -> awaiting_approval` | Implicit Grill continuity (Q84): processes human answers via the batch cursor (`last_processed_comment_id`). Once all ambiguities are settled, automatically generates `plan/*` artifacts and the ticket DAG. |
| `/epure approve` | <span class="epure-badge epure-badge--human">Mandatory Human Gate 2</span> | `implementation` | Squash-merges the documentation-only `plan/* -> dev` PR, locks the signed `spec_sha` mandate in `refs/epure/state/<issue>`, opens `feature/<issue>-<slug>`, and executes the ticket DAG (`task/* -> feature/*`). Also supports **idempotent resumption** if re-run after an error. |
| `/epure to-spec` | <span class="epure-badge epure-badge--optional">Optional Override</span> | `spec` | Forces an immediate transition from the Grill to writing `GLOSSARY.md`, ADRs, `DESIGN.md`, and `docs/specs/<slug>.md` on `plan/*`. |
| `/epure to-tickets` | <span class="epure-badge epure-badge--optional">Optional Override</span> | `tickets` | Forces immediate decomposition of the specification on `plan/*` into a dependency-ordered GitHub Issue DAG (`blocked_by`). |
| `/epure status` | <span class="epure-badge epure-badge--optional">Optional Override</span> | *(Read-only)* | Reads `refs/epure/state/<issue>` and posts a fresh summary of the current phase, locked `spec_sha`, and per-ticket progress without mutating code. |
| `/epure cancel` | <span class="epure-badge epure-badge--optional">Optional Override</span> | `cancelled` | Marks the mandate as `cancelled` in `refs/epure/state/<issue>`, stops any new ticket execution, and preserves existing branches and audit logs. |

> **Contextual `/epure` Command Cheat-Sheet Spoiler (`<details>`)**: Every issue comment, sub-issue body, and pull request description posted by EPURE automatically includes a collapsible `<details>` block at the bottom (`⌨️ Commandes /epure disponibles`) summarizing the available slash commands and highlighting the recommended next action for the current lifecycle phase (`grilling`, `tickets`, `implementation`, `suspended`, `cancelled`, or `completed`).

---

## 2. Repository Bootstrap Agent Skill (`/setup-repo` — Recommended)

The **`.agents/skills/setup-repo/SKILL.md`** skill is the **preferred way** to onboard or reconfigure an EPURE consumer repository from Cursor, Claude Code, Pi, or Codex:

```text
/setup-repo <owner>/<repo>
```

### What the `/setup-repo` Skill Does

1. **Project Discovery**: Inspects the repository stack (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`), `src/` module layout, and whether a user interface is present.
2. **Dry-Run Simulation (`--dry-run`)**: Runs `dist/cli/setup-repo.mjs --dry-run` and presents the full plan to the human maintainer before writing anything.
3. **Dynamic `.cursor/agents/*.md` Roster Design**: Creates, designs, and tailors specialist reviewers according to the project's actual elements (always-on core `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `user-advocate` + tailored domain/UI specialists with `paths:` routing).
4. **Idempotent Application (`--apply --apply-github-settings`)**: Writes `.github/agents.yml`, SHA-pinned caller workflows, configures squash-only merges, and provisions the 3 Repository Rulesets.

---

## 3. Underlying Bootstrap CLI (`dist/cli/setup-repo.mjs`)

Invoked automatically by the `/setup-repo` skill (or runnable directly from a terminal):

```bash
node dist/cli/setup-repo.mjs \
  --repo <owner>/<name> \
  --target-dir <path> \
  [--dry-run | --apply] \
  [--apply-github-settings] \
  [--no-frontend-reviewers] \
  [--domain-reviewers <slug1,slug2>] \
  [--agent-app-id <id>] \
  [--release-app-id <id>] \
  [--require-pr-approvals <N>]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--repo <owner/name>` | *(Required)* | Target GitHub repository slug (e.g., `my-org/craft-calculator`). |
| `--target-dir <path>` | Current directory | Local checkout path where `.github/agents.yml`, workflows, and `.cursor/agents/*.md` are written. |
| `--dry-run` | `true` (if `--apply` omitted) | Prints the complete bootstrap plan without modifying local files or calling write APIs. |
| `--apply` | `false` | Writes configuration files, caller workflows, and base `.cursor/agents/*.md` files. |
| `--apply-github-settings` | `false` | Applies squash-only repository settings and the 3 Repository Rulesets via the GitHub REST API. |
| `--no-frontend-reviewers` | `false` | Omits `frontend-reviewer`, `accessibility-reviewer`, and `design-reviewer` for headless repositories. |
| `--domain-reviewers <csv>` | None | Scaffolds additional `.cursor/agents/<slug>-reviewer.md` specialist files for domain subsystems. |
| `--agent-app-id <id>` | Optional | Numeric GitHub App ID of `<owner>-epure-agent` added as PR Bypass Actor on `epure-feature-governance` (`feature/*`). |
| `--release-app-id <id>` | Optional | Numeric GitHub App ID of `<owner>-epure-release` added as sole Bypass Actor on `epure-release-immutability` (`main` and `v*`). |
| `--require-pr-approvals <N>` | `0` | Number of human PR review approvals required on `dev` (`0` for solo-maintainer compatibility; `>=1` for teams). |

---

## 4. Interactive GitHub Apps Wizard (`setup-github-apps-wizard.sh`)

```bash
bash scripts/wizards/setup-github-apps-wizard.sh --repo <owner>/<name>
```

Guides a human maintainer through registering the two GitHub Apps (`<owner>-epure-agent` and `<owner>-epure-release`) via the GitHub App Manifest flow and uploading the 5 required repository secrets (`LLM_API_KEY`, `EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`, `EPURE_RELEASE_APP_ID`, `EPURE_RELEASE_APP_PRIVATE_KEY`).
