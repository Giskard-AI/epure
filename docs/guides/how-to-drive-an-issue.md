# How-To: Drive an Issue End-to-End

This guide provides a practical checklist for steering a feature or complex bugfix from an initial GitHub Issue to a ready-to-merge `feature/* -> dev` Pull Request, including optional overrides and failure recovery.

---

## 1. Launching the Plan (`/epure plan`)

1. Open a GitHub Issue describing the goal, user problem, or feature scope.
2. Post `/epure plan` in a comment.
3. Wait for the `epure-issue-command` workflow to post **Grill Round 1**.

### Tips for Answering the Grill

- **Reply in plain Markdown**: You do not need to prefix your answers with `/epure` while the issue is in phase `grilling`.
- **Multiple comments are safe**: Thanks to the batch cursor (`last_processed_comment_id`), if you add a second comment with an extra constraint while a run is queued, EPURE will process both comments in order.
- **Short-circuiting the Grill (Optional)**: If you feel the questions are already answered and want to jump straight to specification generation, comment `/epure to-spec`.

---

## 2. Reviewing the `plan/*` Pull Request

Once the Grill settles, EPURE opens a `plan/<issue>-<slug> -> dev` Pull Request and creates the ticket DAG. Before commenting `/epure approve`, check:

1. **`GLOSSARY.md`**: Are the new domain terms accurate and free of ambiguity?
2. **`docs/adr/`**: Do the Architectural Decision Records reflect your choices?
3. **`DESIGN.md` (if UI is involved)**: Are the color tokens, typography, and interaction states aligned with your product?
4. **`docs/specs/<slug>.md` & Ticket DAG**: Are the acceptance criteria and `blocked_by` relationships between tickets logical?

---

## 3. Approving & Monitoring Execution (`/epure approve` & `/epure status`)

Post `/epure approve` on the tracking issue.

- To inspect live progress at any time without opening the Actions tab, comment `/epure status` or check the **EPURE Status Dashboard** pinned at the top of the issue body.
- Inside the GitHub Actions run logs, expand the structured `::group::` sections to inspect:
  - Secretless TDD test/build output per ticket.
  - Read-only tool calls (`read_file`, `search_code`) made by each specialist reviewer.
  - Per-reviewer verdicts (`approved` vs. `changes_requested`).

---

## 4. Handling `needs-human` Escalations & Idempotent Resumption

EPURE pauses and applies the `needs-human` label in two situations:

1. **Sensitive Path Modification**: A `task/*` branch modified `.github/workflows/**`, `.github/agents.yml`, `.cursor/agents/**`, or `CODEOWNERS`.
   - *Resolution*: Inspect the diff. If legitimate, add the `approved-sensitive-change` label to the PR and comment `/epure approve` on the tracking issue.
2. **Remediation Cap Reached (`max_code_fix_attempts = 3`)**: A ticket failed tests or reviewer `must_fix` checks 3 times in a row.
   - *Resolution*: Push a manual fix commit to the `task/*` or `feature/*` branch (or clarify the spec), then comment `/epure approve` again on the tracking issue. EPURE's **idempotent resumption** automatically skips all already-closed tickets and resumes from the remaining work.
