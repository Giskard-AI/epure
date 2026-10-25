# Architecture, Security & Multi-Agent Review Model

EPURE is built from the ground up around **Defense-in-Depth**, **Least Privilege**, and **Out-of-Branch Deterministic State**. Every automation boundary is enforced both by GitHub Repository Rulesets and by local runtime sandboxing.

---

## 1. Security & Trust Boundaries Architecture

<ArchifyDiagram
  slug="epure-security-architecture"
  locale="en"
  title="EPURE Security & Trust Boundaries Architecture"
  caption="Interactive architecture diagram showing the Trusted Control Plane, Secretless Sandbox, Out-of-Branch CAS State, and Dual GitHub Apps."
/>

### Key Architectural Invariants

1. **Dual GitHub App Separation (`<owner>-epure-agent` vs. `<owner>-epure-release`, Q82 & Q91)**:
   - The **Agent App** mints short-lived RS256 installation tokens scoped to day-to-day orchestration (`plan/*`, `task/*`, `feature/*`). It is a Bypass Actor **only** on `epure-feature-governance` (`refs/heads/feature/*`), allowing autonomous integration of verified atomic tasks while physically blocking it from merging application code into `dev` or pushing to `main`.
   - The **Release App** is invoked exclusively by `release-promote.yml` under human `workflow_dispatch`. It is the sole Bypass Actor on `epure-release-immutability` (`refs/heads/main` and `refs/tags/v*`).
2. **Secretless Sandbox Execution (Q74)**:
   - When EPURE runs `npm test`, `npm run build`, or `pytest` on a `task/*` branch, the child process environment is scrubbed of `LLM_API_KEY`, `EPURE_AGENT_APP_PRIVATE_KEY`, and `EPURE_RELEASE_APP_PRIVATE_KEY`.
   - A malicious or compromised test script cannot exfiltrate credentials. If sandbox isolation fails, EPURE aborts **fail-closed**.
3. **Out-of-Branch CAS State (`refs/epure/state/<issue>`, Q76)**:
   - State transitions (`last_processed_comment_id`, signed `spec_sha`, retry counters, ticket status table) are stored as JSON blobs inside `refs/epure/state/<issue-number>` updated via atomic `git update-ref` Compare-And-Swap.
   - `dev` and `main` remain 100% free of machine-state commit noise.

---

## 2. Multi-Agent PR Review, Impeccable Gate & AI Squash Pipeline

<ArchifyDiagram
  slug="epure-review-pipeline"
  locale="en"
  title="EPURE Multi-Agent PR Review, Impeccable Gate & Semantic Squash Pipeline"
  caption="Trusted dev roster loading, read-only code inspection tools, Impeccable UI gate, and targeted remediation loop."
/>

### How the Review Pipeline Works (Q92–Q96)

1. **Trusted `dev` Roster Loading & Prompt-Injection Defense (OWASP LLM01)**:
   - Reviewer prompts (`.cursor/agents/*.md`) are **always** loaded from the trusted `dev` branch (with fallback to EPURE's embedded canonical templates), never from the untrusted `task/*` branch under review.
   - All PR diffs, commit messages, and issue comments are wrapped inside `<untrusted_pr_diff>` XML delimiters with explicit instructions to ignore any embedded prompt-override directives.
2. **Dynamic Selection (Up to 4 Specialists + `spec-parity-reviewer`)**:
   - Based on the files touched in the PR diff, EPURE selects up to 4 relevant reviewers from the roster (`domain-backend-reviewer`, `frontend-reviewer`, `infra-reviewer`, `architecture-reviewer`, `security-reviewer`, `standards-reviewer`, `accessibility-reviewer`, `design-reviewer`, `user-advocate`) alongside the mandatory `spec-parity-reviewer`.
3. **Read-Only Codebase Inspection Tools**:
   - Reviewers are not restricted to a narrow unified diff: they can invoke 4 read-only tools (`list_files`, `read_file`, `read_line_range`, `search_code`) to trace callers, types, and domain invariants across the repository.
4. **Targeted Auto-Remediation (`max_code_fix_attempts = 3`)**:
   - If any reviewer emits a `must_fix` item, EPURE runs a targeted code fix in the secretless sandbox and re-runs **only** the reviewers that failed in the previous round plus `spec-parity-reviewer`.
   - On `feature/* -> dev` synthesis PRs, any remediation is routed through a `task/review-fix-*` PR so `epure-feature-governance` is respected.
5. **AI Semantic Squash Synthesis (Q94)**:
   - Immediately before merging a validated PR, a zero-temperature call synthesizes a clean Conventional Commit title (`type(scope): summary (#PR)`) and bulleted body (`Refs #<ticket>` on `feature/*`, `Closes #<issue>` / `Closes #<ticket>` on `dev`).
6. **Integrated Upstream Quality & Audit Engines**:
   - **[Matt Pocock Agent Skills (`mattpocock/skills`)](https://github.com/mattpocock/skills)** — Specification-driven skills (`grill-with-docs`, `to-spec`, `to-tickets`, `tdd`, `code-review`) pinned in `skills-lock.json`.
   - **[Impeccable (`pbakaus/impeccable`)](https://github.com/pbakaus/impeccable)** — Design system (`DESIGN.md`) and WCAG 2.1 AA frontend quality gate (`actions/impeccable`).
   - **[iFixAi (`ifixai-ai/iFixAi`)](https://github.com/ifixai-ai/iFixAi)** — Deterministic authorization trajectory auditing (`actions/ifixai`).
   - **[Archify (`tt-a1i/archify`)](https://github.com/tt-a1i/archify)** — Showcase-validated interactive architecture diagrams (`scripts/archify/`).
   - **[zizmor (`woodruffw/zizmor`)](https://github.com/woodruffw/zizmor)** — GitHub Actions workflow static security analysis (`actions/zizmor-audit`).
   - **[Renovate (`renovatebot/renovate`)](https://github.com/renovatebot/renovate)** — Automated updates of SHA-pinned workflows and dependencies (`auto_migrate`).
