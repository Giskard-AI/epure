# Introduction & The Meaning of EPURE

**EPURE** (`Giskard-AI/epure`) is a GitHub-first, specification-driven software engineering framework that combines **structured human architectural governance** with **autonomous multi-agent TDD implementation and code review**.

**EPURE** brings a deterministic specification lock (`spec_sha`), a single declarative repository configuration (`.github/agents.yml`), and a reproducible issue-to-release workflow to AI-assisted software engineering.

---

## Why the Name "EPURE"?

The name **EPURE** carries a dual meaning rooted in French architectural heritage and modern software engineering:

### 1. The Architectural Blueprint (*L'Épure d'Architecte*)

In classical French architecture, stonecutting (*stéréotomie*), and naval carpentry, **une épure** is the full-scale geometrical working drawing traced on a workshop wall or floor before a single block of stone is cut or a beam is shaped.

In software engineering with AI agents, the most common failure mode is **premature coding**: letting an LLM guess product requirements, invent domain vocabulary, or silently choose trade-offs inside a pull request. EPURE enforces the exact opposite discipline:

1. **Draw the blueprint first**: On a GitHub tracking issue, the maintainer and the agent clarify every ambiguity through a structured interview (**Grill**).
2. **Version the domain and specification**: Before any application code is written, EPURE commits the ubiquitous language (`GLOSSARY.md`), Architectural Decision Records (`docs/adr/`), the functional & technical specification (`docs/specs/<slug>.md`), and—when a user interface is involved—the visual design contract (`DESIGN.md`) onto a dedicated `plan/<issue>-<slug>` branch.
3. **Machine the parts under a locked mandate**: Only after a human maintainer signs the blueprint with `/epure approve` (locking the exact `spec_sha` in `refs/epure/state/<issue>`) do agents execute the dependency-ordered ticket DAG (`task/* -> feature/*`).

### 2. The Bilingual Acronym

**EPURE** also stands for the four pillars of its execution engine:

| Letter | English Acronym | French Acronym | Engineering Role |
| --- | --- | --- | --- |
| **E** | **Engineered** | **Élaboration** | Structured design interview (`/epure plan` & Grill) that surfaces trade-offs before coding. |
| **P** | **Planning** | **Plans** | Versioned `GLOSSARY.md`, ADRs, `DESIGN.md`, Specification, and dependency-ordered ticket DAG (`blocked_by`). |
| **U** | **Unified** | **Usinage** | Secretless TDD implementation loop (`npm test`, `npm run build`, contract checks) on isolated `task/*` branches. |
| **R** | **Review** | **Revue** | Multi-agent specialist code review loaded from trusted `dev`, Impeccable WCAG AA UI gate, and AI semantic squash. |
| **E** | **Execution** | **Exécution** | Governed integration (`feature/* -> dev` human merge) and fast-forward release promotion (`dev -> main`). |

---

## The Three-Tier Step Taxonomy (Q101)

A core principle of EPURE is transparency about **who decides** and **what runs automatically**. Every step in an EPURE workflow belongs to one of three formal categories:

<ArchifyDiagram
  slug="epure-issue-flow"
  locale="en"
  title="EPURE Global Issue & PR Flow (Human Gates, Mandatory & Conditional Steps)"
  caption="The complete EPURE workflow separated into Mandatory Human Gates, Mandatory Automated Pipeline, Conditional UI Gate, and Optional Controls."
/>

### 1. <span class="epure-badge epure-badge--human">Mandatory Human Validation Gates (4)</span>

No agent can ever bypass these four decision points. They require an explicit action from a repository contributor with `write` or `admin` permission:

1. **Gate 1 — Initiate & Answer the Grill (`/epure plan`)**: A maintainer triggers `/epure plan` on a GitHub Issue and answers the clarifying questions until the design frontier is settled.
2. **Gate 2 — Sign the Implementation Mandate (`/epure approve`)**: After reviewing the generated spec and ticket DAG on `plan/<issue>-<slug>`, a maintainer comments `/epure approve`. This directly integrates the `plan/*` artifacts into `feature/<issue>-<slug>` (with additive `GLOSSARY.md` merging and monotonic ADR renumbering, without an intermediate `plan/* -> dev` PR per ADR-0031), locks `spec_sha` in `refs/epure/state/<issue>`, and begins executing the ticket DAG.
3. **Gate 3 — Human Integration Merge (`feature/* -> dev`)**: Once all tickets in the DAG are implemented, reviewed, and squashed into `feature/*` (and verified by `EpicConvergenceAudit`), EPURE opens the final synthesis PR `feature/* -> dev`. The `epure-dev-governance` ruleset **blocks** the Agent App from merging application code into `dev`: a human maintainer must click **Squash and merge**.
4. **Gate 4 — Human Release Promotion (`dev -> main`)**: Promoting `dev` to `main` and publishing a `vX.Y.Z` tag requires a human to trigger the `release-promote.yml` workflow (`workflow_dispatch`).

### 2. <span class="epure-badge epure-badge--auto">Mandatory Automated Steps</span>

Once a human gate is crossed, EPURE executes these steps deterministically on every feature:

- **Blueprint, Goldfish Spec Audit & Ticket DAG Generation**: Runs the zero-context Goldfish specification audit (`runGoldfishSpecAudit`), commits `GLOSSARY.md`, `docs/adr/`, and `docs/specs/<slug>.md` (with `EpicGoalContract`) on `plan/<issue>-<slug>`, and creates GitHub Issues for each atomic task with native `sub_issues` and `blocked_by` dependencies and the `ready-for-agent` label.
- **Secretless Kernel Sandbox TDD Loop**: For each unblocked ticket, applies incremental mutations (`write_repo_file`, `patch_repo_file`, `delete_repo_file`) and runs Stage 1 verification inside an isolated 2-phase Linux kernel sandbox (`landrun` / `bubblewrap`) stripped of `LLM_API_KEY` and GitHub App private keys.
- **Event-Driven External CI, Trusted `dev` Multi-Agent Review & AI Semantic Squash**: Exits immediately while external CI runs (`waiting_ticket_ci`), resumes on `check_suite.completed` / `workflow_run.completed`, runs up to 4 domain-specialized reviewers (loaded strictly from `dev`) plus `spec-parity-reviewer`, and squash-merges `task/* -> feature/*` with a synthesized Conventional Commit title/body (`Refs #<ticket>`).
- **Zero-Context `EpicConvergenceAudit` & Final Synthesis PR Review**: Runs `runEpicConvergenceAudit` on `feature/*` to ensure all `required_entrypoints` are wired and no `forbidden_stubs` remain (spawning Phase 2 convergence tickets if needed), then opens and audits the consolidated synthesis PR `feature/* -> dev` with `Closes #<issue>` and `Closes #<ticket>` trailer links.

### 3. <span class="epure-badge epure-badge--optional">Optional or Conditional Steps</span>

These steps run only when triggered by the nature of the change or by an explicit maintainer command:

- **Conditional UI & Impeccable Gate (automatic when UI exists)**: When the feature or diff touches frontend/UI files (`.vue`, `.tsx`, `.jsx`, `.css`, `.html`), EPURE automatically generates `DESIGN.md`, runs `user-advocate` in `design-gate` mode before `/epure approve`, and enforces `user-advocate` (`implementation-review`) + `impeccable-gate` as blocking checks on every PR. Pure backend/CLI changes skip these steps automatically.
- **Optional Exploratory Prototype (`/prototype` & Isolated Pages Preview)**: When a layout or state interaction cannot be settled in prose during the Grill, a maintainer can request a throwaway prototype on `prototype/*`. Static GitHub Pages preview is **disabled by default** (`enable_pages_preview: false`) and requires explicit opt-in.
- **Optional Granular Slash Commands**:
  - `/epure to-spec`: Validate the Grill frontier (or force early transition) to generate the specification on `plan/*`.
  - `/epure to-tickets`: Validate the specification on `plan/*` and generate the native GitHub ticket DAG (`sub_issues` + `blocked_by`).
  - `/epure continue`: Resume orchestration after a `needs-human` pause, manual fix, or external CI completion (`waiting_ticket_ci` / `waiting_feature_ci`).
  - `/epure sync` (alias `/epure rebase`): Synchronize `dev -> feature/*` (and `feature/* -> task/*`) with 3-way conflict resolution and Stage 1 sandbox verification.
  - `/epure status`: Refresh and post the current orchestration state and ticket table.
  - `/epure cancel` (alias `/epure stop`): Immediately halt orchestration and mark the mandate `cancelled` in `refs/epure/state/<issue>`.
- **Conditional Human Escalation (`needs-human`)**: Triggered automatically if a `task/*` branch touches sensitive paths (`.github/workflows/**`, `.github/agents.yml`, the reviewer roster directory `reviewers_dir/**` (default `.agents/reviewers/**`), `CODEOWNERS`) without an approved exception, or if a ticket still fails after `max_code_fix_attempts = 3` remediation rounds.

---

## Upstream Ecosystem & Credits (ADR-0018)

EPURE builds upon and integrates verified, SHA-pinned upstream repositories, agent skills, design systems, and security tools (full attributions in [`NOTICE`](https://github.com/Giskard-AI/epure/blob/dev/NOTICE) and [`skills-lock.json`](https://github.com/Giskard-AI/epure/blob/dev/skills-lock.json)):

| Upstream Project | License | Role in EPURE |
| --- | --- | --- |
| **[Matt Pocock Agent Skills (`mattpocock/skills`)](https://github.com/mattpocock/skills)** | MIT | Core specification-driven agent skills (`grill-with-docs`, `to-spec`, `to-tickets`, `domain-modeling`, `tdd`, `code-review`, `prototype`, `wizard`, `pr` with credit to [Dex Horthy / HumanLayer](https://github.com/humanlayer/humanlayer)). |
| **[Impeccable (`pbakaus/impeccable`)](https://github.com/pbakaus/impeccable)** | Apache-2.0 | UX/UI design system workflow (`shape`, `DESIGN.md`, `.impeccable/surfaces/*.md`) and deterministic WCAG 2.1 AA / design token quality gate (`actions/impeccable`, `impeccable-gate`). |
| **[Archify (`tt-a1i/archify`)](https://github.com/tt-a1i/archify)** | MIT | Interactive showcase architecture diagram IR & HTML renderer embedded in `scripts/archify/` (`npm run docs:diagrams`). |
| **[iFixAi (`ifixai-ai/iFixAi`)](https://github.com/ifixai-ai/iFixAi)** | Apache-2.0 | Deterministic authorization trajectory and privilege boundary auditing (`actions/ifixai`). |
| **[zizmor (`woodruffw/zizmor`)](https://github.com/woodruffw/zizmor)** | MIT | Static security analysis for GitHub Actions workflows (`actions/zizmor-audit`). |
| **[Renovate (`renovatebot/renovate`)](https://github.com/renovatebot/renovate)** | AGPL-3.0 (Tool) | Automated updates of SHA-pinned workflows and dependencies with optional assisted migration (`auto_migrate`). |
