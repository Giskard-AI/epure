# Architecture, Security & Multi-Agent Review Model

EPURE is built from the ground up around **Defense-in-Depth**, **Least Privilege**, and **Out-of-Branch Deterministic State**. Every automation boundary is enforced both by GitHub Repository Rulesets and by local runtime sandboxing.

> **Interactive Event & Custom Actions Pipeline Diagram**: See the [`epure-ci-actions-flow` diagram in Commands Reference](./commands#2-end-to-end-github-actions-custom-actions-pipeline-epure-ci-actions-flow) for the complete mapping of GitHub events (`issue_comment`, `check_suite`, `workflow_run`, `pull_request`, `workflow_dispatch`), secretless `authorize-command`, environment-scoped `orchestrate-command` (`environment: <llm-env>`), and `release` promotion.

---

## 1. Security & Trust Boundaries Architecture

<ArchifyDiagram
  slug="epure-security-architecture"
  locale="en"
  title="EPURE Security & Trust Boundaries Architecture"
  caption="Interactive architecture diagram showing the Trusted Control Plane, Secretless Sandbox, Out-of-Branch CAS State, and Dual GitHub Apps."
/>

### Key Architectural Invariants

1. **Dual GitHub App Separation & Environment-Scoped Secrets (`<owner>-epure-agent` vs. `<owner>-epure-release`, Q82 & Q91)**:
   - The **Agent App** mints short-lived RS256 installation tokens scoped to day-to-day orchestration (`plan/*`, `task/*`, `feature/*`). Its credentials (`EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`) and `LLM_API_KEY` are scoped to the dedicated agent GitHub Environment (`<llm-env>`) and never exposed to `authorize-command` or public PR workflows. It is a Bypass Actor **only** on `epure-feature-governance` (`refs/heads/feature/*`), allowing autonomous integration of verified atomic tasks while physically blocking it from merging application code into `dev` or pushing to `main`.
   - The **Release App** is invoked exclusively by `release-promote.yml` / `release.yml` under human `workflow_dispatch` inside the protected `release` GitHub Environment (`EPURE_RELEASE_APP_ID`, `EPURE_RELEASE_APP_PRIVATE_KEY`). It is the sole Bypass Actor on `epure-release-immutability` (`refs/heads/main` and `refs/tags/v*`).
2. **Secretless Sandbox Execution (Q74)**:
   - When EPURE runs `npm test`, `npm run build`, or `pytest` on a `task/*` branch, the child process environment is scrubbed of `LLM_API_KEY`, `EPURE_AGENT_APP_PRIVATE_KEY`, and `EPURE_RELEASE_APP_PRIVATE_KEY`.
   - A malicious or compromised test script cannot exfiltrate credentials. If sandbox isolation fails, EPURE aborts **fail-closed**.
3. **Out-of-Branch CAS State (`refs/epure/state/<issue>`, Q76)**:
   - State transitions (`last_processed_comment_id`, signed `spec_sha`, retry counters, ticket status table, and active CI continuation subphases) are stored as JSON blobs inside `refs/epure/state/<issue-number>` updated via atomic `git update-ref` Compare-And-Swap.
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

---

## 3. Multi-Provider `LLMClient`, Native Structured Outputs & Modular Orchestrator (ADR-0029)

1. **Multi-Provider HTTP Router (`src/llm/`)**:
   - Zero-dependency TypeScript `LLMClient` routing `<provider>/<model>` identifiers across **Google Gemini** (`google/`, `gemini/`), **OpenAI** (`openai/`), **Azure OpenAI** (`azure/`), **Azure AI Foundry** (`azure_ai/`), and **Anthropic** (`anthropic/`), with `os.environ/VAR_NAME` lazy resolution from `.github/agents.yml`.
   - Enforces ADR-0012 fail-fast resilience: HTTP `401`/`403` (`AuthenticationError`) and `402` (`QuotaExhaustedError`) immediately halt without silent fallback, while transient `408`/`429`/`5xx` errors apply bounded exponential backoff.
2. **Native Schema-Enforced Structured Outputs (`ResponseSchemaSpec<T>`) & 2-Phase Gemini Tool Loop**:
   - All structured LLM calls (`GrillRoundEvaluation`, `GeneratedPlanningBundle`, `GeneratedTicketImplementation`, multi-agent reviewer findings, `user-advocate`, and squash commit synthesis) send formal JSON Schemas (`responseSchema`, `response_format.json_schema` with recursive `additionalProperties: false`, or `output_config.format`) paired with runtime TypeScript validators in `src/orchestrator/prompts/schemas.ts`.
   - When Google Gemini calls combine repository exploration tools (`list_repo_files`, `search_in_repo_file`, `read_repo_file`) with a `ResponseSchemaSpec`, **Phase 1** executes tool rounds with `functionDeclarations` (preserving Gemini 3 `thoughtSignature` tokens), and **Phase 2** finalizes with `functionCallingConfig.mode = "NONE"` + `responseMimeType: "application/json"` + `responseSchema`.
3. **Modular `src/orchestrator/` Architecture & Wired Safety Guards**:
   - `src/orchestrator/issue-orchestrator.ts` acts as a clean coordinator delegating to `github/rest-client.ts`, `workspace/repo-tools.ts`, `prompts/schemas.ts`, `formatting/comments.ts`, and the phase modules `phases/grill-and-plan.ts`, `phases/ticket-execution.ts`, and `phases/feature-integration.ts`.
   - Enforces DAG cycle detection (`validatePlanningArtifactsAndGraph`), proven blocker resolution (`reconcileProvenTicketDependencies`, escalating to `needs-human` on `not_planned` closures), mid-run `/epure cancel` batch cursor checks (`processPendingIssueCommentsBatch`), and commit-SHA review loop guards (`evaluateReviewFeedbackTrigger`).

---

## 4. 3-Stage Verification Pipeline, Ubuntu 26.04 Kernel Sandbox & Event-Driven CI Continuation (ADR-0028, ADR-0030, ADR-0031)

1. **Stage 1 — 2-Phase Linux Kernel Sandbox, Stateless `rtk` Condensation & Per-Ticket Goldfish Isolation**:
   - Runs on `ubuntu-26.04` (Linux kernel 7.0) inside a persistent local Git clone before any commit is pushed to `task/*`:
     - **Phase A (`install`, `networkPolicy: "https_only"`)**: Executes dependency installation under `landrun` (Landlock ABI v8), restricting outbound TCP to port `443` and filesystem writes to `workDir`, `/tmp`, and package caches.
     - **Phase B (`codegen`, `typecheck`, `lint`, `test`, `build`, `networkPolicy: "offline"`)**: Executes completely offline under `bubblewrap` (`bwrap --unshare-net --unshare-pid --unshare-ipc --tmpfs /tmp --die-with-parent`, with automatic fallback to offline `landrun`).
   - **Stateless `rtk` Output Condensation (`formatAndCondenseStage1CommandOutput`)**: Strips ANSI sequences, progress bars, and noisy test logs in 100% stateless mode (`RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, no SQLite database) while preserving the raw 4,000-character error tail whenever `exit_code !== 0`.
   - **3-Way Git Branch Sync (`/epure sync`) & Goldfish Isolation**: Keeps `dev -> feature/* -> task/*` synchronized with 3-way LLM conflict resolution validated by Stage 1, and executes each ticket in a fresh zero-context Goldfish session (`runGoldfishSpecAudit` during `/epure to-spec`).
2. **Stage 2 — Event-Driven External CI Continuation (`waiting_ticket_ci` / `waiting_feature_ci`)**:
   - Once Stage 1 passes and the `task/* -> feature/*` or `feature/* -> dev` Pull Request is opened alongside the `ai-review` check, EPURE records `subphase: "waiting_ticket_ci"` (or `"waiting_feature_ci"`), `active_pr_number`, and `active_head_sha` in `refs/epure/state/<issue>` and immediately exits `0` (`async_ci_continuation: true`).
   - No runner sits idle polling external workflows. When GitHub emits `check_suite.completed` or `workflow_run.completed` (or a human posts `/epure continue`), EPURE resumes from the exact persisted state.
3. **Stage 3 — Trusted `dev` Multi-Agent Review Roster & AI Semantic Squash**:
   - Correlates external CI results with the multi-agent specialist review roster loaded from `dev`. If external CI or any reviewer fails, EPURE extracts sanitized failure logs (~12 KB) and executes up to `max_code_fix_attempts = 3` unified remediation rounds before AI semantic squash-merging `task/* -> feature/*`.

---

## 5. Incremental Workspace Mutation Tools, Inter-Ticket Guard & Multi-Phase Epic Convergence (ADR-0032, ADR-0033)

1. **Transactional Incremental Workspace Mutation (`StagedTicketImplementationBuffer`)**:
   - During ticket implementation and remediation tool loops, the model mutates files incrementally via `write_repo_file`, `patch_repo_file`, and `delete_repo_file` inside an in-memory transactional buffer (`StagedTicketImplementationBuffer`), isolated from `feature/*` until `validateWorkspaceFileOperations`, `validateTicketIntegrityGuard`, and Stage 1 sandbox checks succeed.
   - **Chunked File-by-File Fallback (`ChunkedTicketImplementationFallback`)**: If a multi-file ticket hits `MAX_TOKENS` output truncation, EPURE automatically decomposes the remaining `filesToTouch` entries into file-by-file sub-calls (preserving already staged mutations in the buffer and rolling back atomically if any sub-call fails).
   - **Zero-Truncation Context Catalog (`CompactWorkspaceFilesContext`)**: Injects full, untruncated file contents only for files modified by the ticket or listed in `filesToTouch`, and exposes the rest of the repository as a compact `path (N lines)` index inspectable on demand via `read_repo_file` and `search_in_repo_file`.
2. **Native GitHub Relational Graph, Inter-Ticket Integrity Guard & Semantic ADR Reconciliation**:
   - `/epure to-tickets` wires native GitHub `sub_issues` and `dependencies/blocked_by` relationships alongside the Markdown tasklist on the tracking issue.
   - `validateTicketIntegrityGuard` blocks any ticket from deleting or emptying pre-existing test files, truncating >30% of lines/exports on out-of-scope files, or downgrading manifest `build`/`test`/`lint`/`typecheck` scripts into no-op commands.
   - `renumberCollidingAdrs` and `reconcileAdrsWithLlm` deduplicate ADR slugs across concurrent branches, renumber colliding `docs/adr/NNNN-*.md` files monotonically, and align cross-references in specs and `GLOSSARY.md`.
3. **Zero-Context `EpicConvergenceAudit` & Multi-Phase Remediation (`max_epic_phases`)**:
   - Before opening the final `feature/* -> dev` PR, an isolated zero-context session (`runEpicConvergenceAudit`) verifies the feature branch against the specification's `EpicGoalContract` (`required_entrypoints`, absence of `forbidden_stubs`, and `end_to_end_verification_criteria`).
   - If unwired modules or stubs are detected (`verdict: "INCOMPLETE"`) and `epic_phase < max_epic_phases` (default `2`), EPURE automatically generates, links, and executes bounded **Phase 2 convergence tickets** (`[Phase 2 - Ticket N]`) before opening the final PR; otherwise it escalates with `epic_convergence_exhausted` (`needs-human`).
