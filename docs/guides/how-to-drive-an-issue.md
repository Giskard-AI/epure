# How-To: Drive an Issue End-to-End

This guide provides a practical checklist for steering a feature or complex bugfix from an initial GitHub Issue to a ready-to-merge `feature/* -> dev` Pull Request, including optional overrides and failure recovery.

---

## 1. Launching the Plan (`/epure plan`)

<ArchifyDiagram
  slug="epure-user-journey"
  locale="en"
  title="EPURE User Journey: Driving an Issue from Idea to Merged PR"
  caption="Complete user journey across 4 lanes: 1. What I Do -> 2. What Happens Behind the Scenes -> 3. When I Act Again -> 4. Autofix Loops, Conflicts & Steering."
/>

1. Open a GitHub Issue describing the goal, user problem, or feature scope.
2. Post `/epure plan` in a comment.
3. Wait for the `epure-issue-command` workflow to post **Grill Round 1**.

### Tips for Answering the Grill

- **Reply in plain Markdown**: You do not need to prefix your answers with `/epure` while the issue is in phase `grilling`.
- **Multiple comments are safe**: Thanks to the batch cursor (`last_processed_comment_id`), if you add a second comment with an extra constraint while a run is queued, EPURE will process both comments in order.
- **Short-circuiting the Grill (Optional)**: If you feel the questions are already answered and want to jump straight to specification generation, comment `/epure to-spec`.

---

## 2. Generating & Reviewing the Specification (`/epure to-spec` & `/epure to-tickets`)

Once the Grill decision frontier is resolved (`frontier_resolved: true`), EPURE posts a **Settled Decisions Summary** and pauses in `grilling` (`awaiting_human_approval`).

1. **Generate the Specification (`/epure to-spec`)**: Comment `/epure to-spec` to run the zero-context **Goldfish Specification Audit** (`runGoldfishSpecAudit`) and commit `GLOSSARY.md`, `docs/adr/NNNN-*.md`, `DESIGN.md` (if UI is involved), and `docs/specs/<slug>.md` (including `EpicGoalContract`) onto `plan/<issue>-<slug>`. The issue transitions to `spec` (`awaiting_human_approval`).
2. **Revise or Validate the Specification**:
   - Inspect `GLOSSARY.md`, `docs/adr/`, and `docs/specs/<slug>.md` on `plan/<issue>-<slug>`.
   - To request adjustments to the specification before creating tickets, **reply directly in a comment** (without a slash command).
3. **Generate the Ticket DAG (`/epure to-tickets`)**: Once the specification is approved, comment `/epure to-tickets`. EPURE decomposes the spec into an acyclic dependency-ordered GitHub Issue DAG (`blocked_by`, `ready-for-agent`), wires native GitHub `sub_issues` and `dependencies/blocked_by` graph links, and pauses in `tickets` (`awaiting_human_approval`) awaiting `/epure approve`.

---

## 3. Approving, Event-Driven CI Continuation & Branch Sync (`/epure approve`, `/epure status` & `/epure sync`)

Post `/epure approve` on the tracking issue to directly integrate the `plan/*` artifacts into `feature/<issue>-<slug>`, lock `spec_sha`, and start executing the ticket DAG.

- **Event-Driven External CI Waiting (`waiting_ticket_ci` / `waiting_feature_ci`)**:
  - Whenever EPURE opens a `task/* -> feature/*` PR (`waiting_ticket_ci`) or the final `feature/* -> dev` PR (`waiting_feature_ci`), the orchestrator records the active PR and `head_sha` in `refs/epure/state/<issue>` and immediately exits `0` to release the GitHub Actions runner (`async_ci_continuation: true`).
  - As soon as external CI workflows complete (`check_suite.completed` or `workflow_run.completed`), EPURE automatically wakes up to run Stage 3 multi-agent review, AI semantic squash, or unified auto-remediation. You can also manually nudge continuation at any time by commenting **`/epure continue`**.
- **Synchronizing with `dev` (`/epure sync` / `/epure rebase`)**:
  - If other PRs land on `dev` while your feature is in progress, comment **`/epure sync`** (or `/epure rebase`). EPURE merges `dev -> feature/<issue>-<slug>` (and cascades `feature/* -> active_task_branch`) with additive `GLOSSARY.md` merging, monotonic ADR renumbering, 3-way LLM conflict resolution, and mandatory **Stage 1 Kernel Sandbox** verification before committing.
- **Inspecting Live Progress (`/epure status`)**:
  - Comment `/epure status` or check the **EPURE Status Dashboard** pinned at the top of the issue body.
  - Inside the GitHub Actions run logs, expand the structured `::group::` sections to inspect Stage 1 kernel sandbox test/build output, read-only reviewer tool calls (`read_file`, `search_code`), and per-reviewer verdicts (`approved` vs. `changes_requested`).

---

## 4. Handling `needs-human` Escalations, `/epure continue` & Phase 2 Convergence Tickets

EPURE pauses and applies the `needs-human` label (`status: "suspended"`) when human judgment is required:

1. **Sensitive Path Modification**: A `task/*` branch modified `.github/workflows/**`, `.github/agents.yml`, the reviewer roster directory (`<reviewers_dir>/**`, default `.agents/reviewers/**`), or `CODEOWNERS`.
   - *Resolution*: Inspect the diff. If legitimate, add the `approved-sensitive-change` label to the PR and comment **`/epure continue`** (or `/epure approve`) on the tracking issue.
2. **Remediation Cap Reached (`max_code_fix_attempts = 3`)**: A ticket failed Stage 1 tests, external CI, or reviewer `must_fix` checks 3 times in a row.
   - *Resolution*: Push a manual fix commit to the `task/*` or `feature/*` branch (or post a clarifying comment), then comment **`/epure continue`** on the tracking issue. EPURE removes `needs-human`, restores `status: "active"`, skips all already-closed tickets, and resumes from the current milestone.
3. **Zero-Context `EpicConvergenceAudit` & Automatic Phase 2 Tickets (`max_epic_phases`)**:
   - After all Phase 1 tickets are squashed into `feature/*`, EPURE runs a zero-context **`EpicConvergenceAudit`** (`runEpicConvergenceAudit`) against the specification's `EpicGoalContract`.
   - If the audit finds unwired `required_entrypoints` or lingering `forbidden_stubs` (`verdict: "INCOMPLETE"`) and `epic_phase < max_epic_phases` (default `2`), EPURE automatically creates, links, and executes bounded **`[Phase 2 - Ticket N]`** convergence tickets before opening the final `feature/* -> dev` PR. If gaps still remain after `max_epic_phases`, EPURE escalates to `needs-human` (`epic_convergence_exhausted`), where you can push a fix and comment **`/epure continue`**.
