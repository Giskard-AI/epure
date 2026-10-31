# Basic Usage (Real-World Case Study: `craft-calculator`)

To understand how EPURE works in practice, this guide walks through a complete, anonymized real-world feature lifecycle on a TypeScript/React web application called **`my-org/craft-calculator`** (a probability and cost optimizer for an incremental crafting system).

We will follow **Issue #16** from its initial 3-line description all the way to the **`v1.0.0`** production release on `main`.

---

## Your End-to-End User Journey at a Glance

At every step of driving an issue, EPURE separates **what you do**, **what runs automatically behind the scenes**, **when EPURE pauses for your next action**, and **how autofix loops, Git conflicts, and recovery work**:

<ArchifyDiagram
  slug="epure-user-journey"
  locale="en"
  title="EPURE User Journey: What I Do, Behind the Scenes, When to Act & Autofix Loops"
  caption="Interactive user-centric view of the 4 questions at every stage: your commands, automated execution, wait states, and recovery controls."
/>

| Stage | 1. What Do I Do? | 2. What Happens Behind the Scenes? | 3. When Do I Act Again & 4. How Do I Steer? |
| --- | --- | --- | --- |
| **1. Grill & Framing** | Open the GitHub Issue, post `/epure plan`, and reply to Grill questions in plain text. | Inspects the codebase, initializes `refs/epure/state/<issue>`, and posts targeted Grill rounds until the design frontier is settled. | **Act again** after each Grill round (reply in plain text without slash commands), or run `/epure to-spec` when settled. |
| **2. Blueprint & Spec** | Comment `/epure to-spec` (and optionally post plain-text adjustments). | Creates `plan/<issue>-<slug>`, runs the zero-context **Goldfish Specification Audit**, and commits `GLOSSARY.md`, ADRs, `DESIGN.md` (if UI), and `docs/specs/<slug>.md`. | **Act again** once the spec draft is committed: reply in plain text to revise the spec, or comment `/epure to-tickets` when satisfied. |
| **3. Ticket DAG & Mandate** | Comment `/epure to-tickets`, review the sub-issues, then comment `/epure approve`. | Wires native GitHub `sub_issues` and `blocked_by` links, merges `plan/* -> feature/*` directly, and locks `spec_sha` in `refs/epure/state/<issue>`. | **No action required** once `/epure approve` is posted—EPURE immediately starts executing the ticket DAG. |
| **4. Autonomous Ticket Loop** | Nothing during normal execution (optional `/epure status` or `/epure sync`). | For each ticket (`task/* -> feature/*`): **Stage 1** 2-phase kernel sandbox TDD (`bwrap`/`landrun` + `rtk`) -> **Stage 2** zero-cost async CI wait (`waiting_ticket_ci`) -> **Stage 3** trusted `dev` multi-agent review + AI Semantic Squash. | **Autofix 1..3** automatically fixes Stage 1, CI, or review failures. Comment `/epure sync` for 3-way Git conflicts, or `/epure continue` if paused in `needs-human`. |
| **5. Convergence & Final Merge** | Review the final `feature/* -> dev` PR and click **Squash and merge** (plus optional `release-promote.yml` for `dev -> main`). | Runs zero-context **`EpicConvergenceAudit`** (spawning Phase 2 tickets automatically if incomplete), opens `feature/* -> dev`, and runs final synthesis CI & review. | **Act again** when the synthesis PR `feature/* -> dev` is green to perform the human Squash & Merge into `dev`. |

---

## Visual State Machine of the Issue

Throughout this walkthrough, EPURE persists the orchestration state outside standard branches inside the atomic Git reference `refs/epure/state/16`:

<ArchifyDiagram
  slug="epure-state-machine"
  locale="en"
  title="EPURE Issue State Machine (CAS Git Ref: refs/epure/state/<issue>)"
  caption="Atomic Compare-And-Swap transitions in refs/epure/state/16 from Grilling to Completed."
/>

---

## Step 1: Open the Issue & Start the Grill

<span class="epure-badge epure-badge--human">Mandatory Human Gate 1</span>

A maintainer opens **Issue #16** (*"Add exact Markov-chain crafting simulator and responsive web dashboard"*) and posts a comment:

```text
/epure plan
```

### What EPURE Does Automatically

1. **Permission Gate**: Verifies that the commenter has `write` or `admin` access to `my-org/craft-calculator`.
2. **State Initialization**: Creates `refs/epure/state/16` in phase `grilling` and adds the `EPURE Status Dashboard` at the top of Issue #16.
3. **Structured Grill Round 1**: Inspects the repository and posts 4 targeted architectural questions on Issue #16:
   - *Q1: Should expected cost be computed via Monte Carlo simulation or exact absorbing Markov chains (`45 x 45` transition matrix)?*
   - *Q2: How should irreversible corruption states be modeled in the state space?*
   - *Q3: What is the persistence model for user price presets (backend DB vs. versioned `localStorage`)?*
   - *Q4: Does the web calculator require WCAG 2.1 AA contrast and mobile responsive layout (`320px`–`1440px`)?*

### Replying to the Grill (Implicit Continuity — Q84)

Because Issue #16 is in the `grilling` phase, **you do not need to type another slash command**. Simply reply in a normal GitHub comment:

```text
1. Exact absorbing Markov chain solver (Gaussian elimination, zero Monte Carlo variance).
2. Model corruption as an absorbing failure state that triggers item replacement cost.
3. Pure client-side SPA deployed on GitHub Pages with versioned localStorage.
4. Yes, enforce WCAG 2.1 AA and mobile-first responsive layout via Impeccable.
```

> **Batch Comment Cursor (`last_processed_comment_id`, Q75)**: If you post two or three follow-up comments in a row while the runner is queued, EPURE reads all unprocessed comments in strict chronological order on startup—no comment is ever lost.

---

## Step 2: Blueprint, Goldfish Spec Audit & Native Ticket Graph (`/epure to-spec` & `/epure to-tickets`)

<span class="epure-badge epure-badge--auto">Mandatory Automated Step</span> + <span class="epure-badge epure-badge--optional">Conditional UI Gate</span>

Once your reply settles all open questions on the design frontier, EPURE posts a **Settled Decisions Summary** and pauses in `grilling` (`awaiting_human_approval`).

1. **Generate & Audit the Specification (`/epure to-spec`)**:
   - Creates branch **`plan/16-markov-craft-calculator`** from `dev`.
   - Runs a zero-context **Goldfish Specification Audit** (`runGoldfishSpecAudit`) to verify self-containment, YAGNI discipline, and implementation readiness without Grill conversation bias, automatically amending any gaps.
   - Commits the domain and specification artifacts onto `plan/16-markov-craft-calculator`:
     - `GLOSSARY.md` (defining *Transition Matrix*, *Absorbing State*, *Expected Craft Cost*).
     - `docs/adr/0001-exact-markov-solver-and-spa.md`.
     - `DESIGN.md` (automatically generated because Issue #16 includes a UI surface, defining dark/light tokens, WCAG AA contrast, and responsive breakpoints).
     - `docs/specs/16-markov-craft-calculator.md` (complete specification including the `EpicGoalContract` entrypoints and `user-advocate` **`design-gate`** persona UX acceptance criteria).
   - Pauses in phase `spec` (`awaiting_human_approval`) so you can review or revise the spec via plain-text comments on `plan/16-markov-craft-calculator` (no intermediate `plan/* -> dev` PR is opened).
2. **Generate the Native GitHub Ticket DAG (`/epure to-tickets`)**:
   - Decomposes the validated specification into an acyclic dependency-ordered Ticket DAG on GitHub and wires native GitHub **`sub_issues`** and **`dependencies/blocked_by`** links:
     - **Issue #25**: *Core absorbing Markov solver & unit tests* (`ready-for-agent`, `blocked_by: []`)
     - **Issue #26**: *Preset price editor & versioned localStorage hook* (`ready-for-agent`, `blocked_by: [#25]`)
     - **Issue #27**: *Responsive simulator UI & Impeccable accessibility verification* (`ready-for-agent`, `blocked_by: [#25, #26]`)
   - Pauses in phase `tickets` (`awaiting_human_approval`) awaiting `/epure approve`.

---

## Step 3: Sign the Mandate (`/epure approve`)

<span class="epure-badge epure-badge--human">Mandatory Human Gate 2</span>

After reviewing the specification on `plan/16-markov-craft-calculator` and the ticket breakdown, the maintainer comments on Issue #16:

```text
/epure approve
```

### What `/epure approve` Locks In (ADR-0031, ADR-0032)

- Creates the integration branch **`feature/16-markov-craft-calculator`** from `dev` and **directly integrates the `plan/16-markov-craft-calculator` artifacts** into `feature/16-markov-craft-calculator` (with additive `GLOSSARY.md` merging and monotonic ADR renumbering if `dev` advanced, without opening a `plan/* -> dev` PR).
- Records the signed mandate in `refs/epure/state/16` (`spec_sha`, `approved_by`, `approved_at`, `status: "active"`).

---

## Step 4: Incremental Tools, 3-Stage Verification & Event-Driven CI (`task/* -> feature/*`)

<span class="epure-badge epure-badge--auto">Mandatory Automated Step</span> + <span class="epure-badge epure-badge--optional">Conditional UI Gate</span>

EPURE now executes the ticket DAG in topological order (`#25`, then `#26`, then `#27`):

1. **Incremental File Mutation & Stage 1 Kernel Sandbox**:
   - Creates `task/25-markov-solver` from `feature/16-markov-craft-calculator`.
   - Applies code and test changes via incremental workspace tools (`write_repo_file`, `patch_repo_file`, `delete_repo_file`) staged inside `StagedTicketImplementationBuffer` and verified by `validateTicketIntegrityGuard`.
   - Runs **Stage 1 Verification** inside the 2-phase Ubuntu 26.04 Linux kernel sandbox (`landrun` `https_only` install, offline `bwrap --unshare-net` typecheck/lint/test/build with stateless `rtk` output condensation, completely stripped of `LLM_API_KEY` and GitHub App private keys).
   - Opens **PR #28** (`task/25-markov-solver -> feature/16-markov-craft-calculator`).
2. **Stage 2 Event-Driven External CI (`waiting_ticket_ci`)**:
   - Persists `subphase: "waiting_ticket_ci"` in `refs/epure/state/16` and exits `0` immediately so no runner sits idle while GitHub Actions runs external CI on PR #28.
   - Automatically wakes up when `check_suite.completed` / `workflow_run.completed` fires on `task/25-markov-solver`.
3. **Stage 3 Multi-Agent Review (from trusted `dev`) & AI Semantic Squash**:
   - Loads `.cursor/agents/*.md` strictly from `dev` (never from `task/25-*`).
   - Selects up to 4 relevant reviewers (e.g., `domain-backend-reviewer`, `standards-reviewer`, `security-reviewer`) plus `spec-parity-reviewer`.
   - For **Ticket #27** (which touches `.tsx` and `.css` files), automatically includes `frontend-reviewer`, `accessibility-reviewer`, `design-reviewer`, `user-advocate` (`implementation-review`), and the **`impeccable-gate`** check.
   - If external CI or a reviewer emits a `must_fix`, EPURE runs a targeted remediation round (up to `max_code_fix_attempts = 3`).
   - Once green, EPURE synthesizes a Conventional Commit title and body (`feat(solver): implement exact absorbing Markov chain solver (#28)` with `Refs #25`) and performs an autonomous squash-merge via the `epure-feature-governance` ruleset.

---

## Step 5: Zero-Context `EpicConvergenceAudit`, Final Synthesis PR & Human Merge into `dev`

<span class="epure-badge epure-badge--auto">Mandatory Automated Step</span> -> <span class="epure-badge epure-badge--human">Mandatory Human Gate 3</span>

Once tickets `#25`, `#26`, and `#27` are merged into `feature/16-markov-craft-calculator`:

1. **Zero-Context `EpicConvergenceAudit` (`runEpicConvergenceAudit`)**: Before opening the final PR, an isolated Goldfish session audits `feature/16-markov-craft-calculator` against the specification's `EpicGoalContract` to verify that all `required_entrypoints` are wired end-to-end and no `forbidden_stubs` remain (automatically spawning Phase 2 convergence tickets if any entrypoint was left unwired).
2. EPURE opens the final synthesis **PR #47** (`feature/16-markov-craft-calculator -> dev`) with `Closes #16`, `Closes #25`, `Closes #26`, `Closes #27`.
3. Runs the full synthesis multi-agent review, `impeccable-gate`, and event-driven external CI (`waiting_feature_ci`) on the consolidated diff, updating the PR title and body with a synthesized Conventional Commit summary.
4. **Human Gate 3**: Because `epure-dev-governance` forbids the Agent App from merging code into `dev`, the human maintainer reviews PR #47 and clicks **Squash and merge**. GitHub automatically closes Issues `#16`, `#25`, `#26`, and `#27`.

---

## Step 6: Promote Release `dev -> main` (`v1.0.0`)

<span class="epure-badge epure-badge--human">Mandatory Human Gate 4</span>

When ready to cut a production release, the maintainer triggers the **`Release Promote (dev -> main)`** workflow (`workflow_dispatch` with `version: v1.0.0`), or runs via `gh`:

```bash
gh workflow run release-promote.yml -R my-org/craft-calculator -f version=v1.0.0
```

Using the isolated **Release App** (`<owner>-epure-release`), the workflow verifies that `main` is an ancestor of `dev`, performs an atomic fast-forward of `main` to `dev`, and pushes the immutable tag `v1.0.0`.
