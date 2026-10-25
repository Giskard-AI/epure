# Basic Usage (Real-World Case Study: `craft-calculator`)

To understand how EPURE works in practice, this guide walks through a complete, anonymized real-world feature lifecycle on a TypeScript/React web application called **`my-org/craft-calculator`** (a probability and cost optimizer for an incremental crafting system).

We will follow **Issue #16** from its initial 3-line description all the way to the **`v1.0.0`** production release on `main`.

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

## Step 2: Blueprint, `DESIGN.md`, Spec & Ticket DAG

<span class="epure-badge epure-badge--auto">Mandatory Automated Step</span> + <span class="epure-badge epure-badge--optional">Conditional UI Gate</span>

Once your reply settles all open questions on the design frontier, EPURE automatically transitions from **Grill** to **Blueprint & Tickets**:

1. **Creates branch `plan/16-markov-craft-calculator`** from `dev`.
2. **Commits the domain and specification artifacts**:
   - `GLOSSARY.md` (defining *Transition Matrix*, *Absorbing State*, *Expected Craft Cost*).
   - `docs/adr/0001-exact-markov-solver-and-spa.md`.
   - `DESIGN.md` (automatically generated because Issue #16 includes a UI surface, defining dark/light tokens, WCAG AA contrast, and responsive breakpoints).
   - `docs/specs/16-markov-craft-calculator.md` (complete specification enriched by `user-advocate` in **`design-gate`** mode with persona UX acceptance criteria).
3. **Creates the Dependency-Ordered Ticket DAG**:
   - **Issue #25**: *Core absorbing Markov solver & unit tests* (`ready-for-agent`, `blocked_by: []`)
   - **Issue #26**: *Preset price editor & versioned localStorage hook* (`ready-for-agent`, `blocked_by: [#25]`)
   - **Issue #27**: *Responsive simulator UI & Impeccable accessibility verification* (`ready-for-agent`, `blocked_by: [#25, #26]`)
4. **Opens PR `plan/16-markov-craft-calculator -> dev`** and pauses in state **`awaiting_approval`**.

---

## Step 3: Sign the Mandate (`/epure approve`)

<span class="epure-badge epure-badge--human">Mandatory Human Gate 2</span>

After reviewing the specification and ticket breakdown on the `plan/*` PR, the maintainer comments on Issue #16:

```text
/epure approve
```

### What `/epure approve` Locks In

- Squash-merges the documentation-only PR `plan/16-markov-craft-calculator -> dev`.
- Records the signed mandate in `refs/epure/state/16` (`spec_sha`, `approved_by`, `approved_at`, `status: "active"`).
- Creates the integration branch **`feature/16-markov-craft-calculator`** from `dev`.

---

## Step 4: Secretless TDD & Multi-Agent PR Reviews (`task/* -> feature/*`)

<span class="epure-badge epure-badge--auto">Mandatory Automated Step</span> + <span class="epure-badge epure-badge--optional">Conditional UI Gate</span>

EPURE now executes the ticket DAG in topological order (`#25`, then `#26`, then `#27`):

1. **Secretless Sandbox TDD**:
   - Creates `task/25-markov-solver` from `feature/16-markov-craft-calculator`.
   - Runs `npm test` and `npm run build` inside the isolated sandbox (`LLM_API_KEY` and GitHub App private keys are stripped from the child environment).
   - Opens **PR #28** (`task/25-markov-solver -> feature/16-markov-craft-calculator`).
2. **Independent Multi-Agent Review (from trusted `dev`)**:
   - Loads `.cursor/agents/*.md` strictly from `dev` (never from `task/25-*`).
   - Selects up to 4 relevant reviewers (e.g., `domain-backend-reviewer`, `standards-reviewer`, `security-reviewer`) plus `spec-parity-reviewer`.
   - For **Ticket #27** (which touches `.tsx` and `.css` files), automatically includes `frontend-reviewer`, `accessibility-reviewer`, `design-reviewer`, `user-advocate` (`implementation-review`), and the **`impeccable-gate`** check.
   - If a reviewer emits a `must_fix`, EPURE runs a targeted remediation round (up to `max_code_fix_attempts = 3`) and re-runs only the failed reviewers + `spec-parity-reviewer`.
3. **AI Semantic Squash Merge**:
   - Just before merging each `task/*` PR into `feature/16-markov-craft-calculator`, EPURE synthesizes a clean Conventional Commit title and body (`feat(solver): implement exact absorbing Markov chain solver (#28)` with `Refs #25`) and performs an autonomous squash-merge via the `epure-feature-governance` ruleset.

---

## Step 5: Final Synthesis PR & Human Merge into `dev`

<span class="epure-badge epure-badge--auto">Mandatory Automated Step</span> -> <span class="epure-badge epure-badge--human">Mandatory Human Gate 3</span>

Once tickets `#25`, `#26`, and `#27` are merged into `feature/16-markov-craft-calculator`:

1. EPURE opens the final synthesis **PR #47** (`feature/16-markov-craft-calculator -> dev`) with `Closes #16`, `Closes #25`, `Closes #26`, `Closes #27`.
2. Runs the full synthesis multi-agent review and `impeccable-gate` on the consolidated diff.
3. Updates the PR title and body with a synthesized Conventional Commit summary.
4. **Human Gate 3**: Because `epure-dev-governance` forbids the Agent App from merging code into `dev`, the human maintainer reviews PR #47 and clicks **Squash and merge**. GitHub automatically closes Issues `#16`, `#25`, `#26`, and `#27`.

---

## Step 6: Promote Release `dev -> main` (`v1.0.0`)

<span class="epure-badge epure-badge--human">Mandatory Human Gate 4</span>

When ready to cut a production release, the maintainer triggers the **`Release Promote (dev -> main)`** workflow (`workflow_dispatch` with `version: v1.0.0`), or runs via `gh`:

```bash
gh workflow run release-promote.yml -R my-org/craft-calculator -f version=v1.0.0
```

Using the isolated **Release App** (`<owner>-epure-release`), the workflow verifies that `main` is an ancestor of `dev`, performs an atomic fast-forward of `main` to `dev`, and pushes the immutable tag `v1.0.0`.
