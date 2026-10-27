# Domain Glossary (English / French Ubiquitous Language)

In accordance with **Q102**, the root `/GLOSSARY.md` file is the single canonical source of truth for EPURE's domain model (rendered natively in the [French Glossary](/fr/reference/glossary)).

This page provides the aligned **English <-> French** ubiquitous language reference table across all architectural rounds (Q1–Q103).

---

## 1. Workflow Step Taxonomy (Q101)

| English Term | French Canonical Term (`GLOSSARY.md`) | Definition & Invariant |
| --- | --- | --- |
| **Mandatory Human Validation Gates (4)** | *Portes de validation humaine obligatoires (4 jalons)* | The 4 decision points that require an explicit action from a `write+` human contributor and can never be delegated to an agent: (1) `/epure plan` & Grill replies, (2) `/epure approve` locking `spec_sha`, (3) Human squash-merge of `feature/* -> dev`, and (4) Human `workflow_dispatch` of `release-promote.yml`. |
| **Mandatory Automated Steps** | *Étapes automatisées obligatoires* | Deterministic pipeline executed on every approved feature: `plan/*` artifact & ticket DAG generation, secretless TDD loop on `task/*`, multi-agent review from `dev` + AI semantic squash (`task/* -> feature/*`), and synthesis review on `feature/* -> dev`. |
| **Optional or Conditional Steps** | *Étapes facultatives ou conditionnelles* | Steps triggered either conditionally by the change surface (`DESIGN.md` + `user-advocate` + `impeccable-gate` when UI files exist; `needs-human` escalation on sensitive paths or `>3` fix attempts) or optionally by human command (`/prototype`, isolated Pages preview, `/epure to-spec`, `/epure to-tickets`, `/epure status`, `/epure cancel`). |

---

## 2. Core Orchestration & Branch Topology (Q1–Q85)

| English Term | French Canonical Term (`GLOSSARY.md`) | Definition & Invariant |
| --- | --- | --- |
| **Tracking Issue (Orchestration Issue)** | *Issue de pilotage* | The GitHub Issue where `/epure plan` is invoked, hosting the Grill conversation, the status dashboard, and the `/epure approve` mandate. |
| **Plan Branch (`plan/<issue>-<slug>`)** | *Branche de plan (`plan/*`)* | Documentation-only branch holding `GLOSSARY.md`, ADRs, `DESIGN.md`, and `docs/specs/<slug>.md` before `/epure approve` merges it into `dev`. |
| **Feature Integration Branch (`feature/<issue>-<slug>`)** | *Branche d'intégration de fonctionnalité (`feature/*`)* | Branch created from `dev` upon `/epure approve` that receives autonomous squash-merges from `task/*` PRs before the final human merge into `dev`. |
| **Atomic Task Branch (`task/<ticket>-<slug>`)** | *Branche de tâche (`task/*`)* | Short-lived branch implementing a single ticket from the DAG in a secretless TDD sandbox. |
| **Out-of-Branch CAS State Ref (`refs/epure/state/<issue>`)** | *Référence Git d'état d'orchestration (`refs/epure/state/<issue-number>`)* | Dedicated Git reference outside `refs/heads/*` storing the state machine (`last_processed_comment_id`, signed `spec_sha`, retry counters) updated via atomic Compare-And-Swap. |
| **Batch Comment Cursor (`last_processed_comment_id`)** | *Traitement en lot des commentaires avec curseur* | Mechanism reading all unprocessed human comments in chronological order so queued runs never drop events. |
| **Implicit Grill & Spec Revision Continuity** | *Continuité implicite de l'entretien de grill et de la révision de spécification (Q84)* | Automatic processing of any ordinary human comment posted while the issue is in phase `grilling` (Grill answers) or `spec` (specification revision on `plan/*`), without repeating a slash command. |
| **Human Grill Frontier Validation** | *Validation humaine de la frontière de Grill (Q85)* | Pause in `grilling` (`awaiting_human_approval`) with a Settled Decisions Summary once `frontier_resolved: true`, requiring explicit `/epure to-spec` before generating specification files. |
| **Human Specification Validation** | *Validation humaine de la spécification (Q85)* | Separation between `/epure to-spec` (committing `GLOSSARY.md`, ADRs, `DESIGN.md`, and `docs/specs/<slug>.md` on `plan/*` in phase `spec` / `awaiting_human_approval`) and `/epure to-tickets` (generating the acyclic GitHub Issue DAG in phase `tickets` / `awaiting_human_approval`). |

---

## 3. Security, Governance & Multi-Agent Review (Q86–Q103)

| English Term | French Canonical Term (`GLOSSARY.md`) | Definition & Invariant |
| --- | --- | --- |
| **Secretless Sandbox & LLM Proxy** | *Proxy LLM de sandbox* | Isolation boundary stripping `LLM_API_KEY` and GitHub App private keys from consumer test/build subprocesses; fails closed if isolation is unavailable. |
| **Three Governance Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`)** | *Séparation des trois Rulesets de gouvernance* | Three distinct GitHub Repository Rulesets: `Agent App` bypasses PRs only on `feature/*`; `dev` requires human merge (`0` review approvals by default for solo maintainer compatibility); `main` and `v*` allow only `Release App`. |
| **Trusted `dev` Reviewer Roster (`.cursor/agents/*`)** | *Roster de reviewers spécialisés et transverses* | Read-only reviewer definitions initialized by `setup-repo`, always loaded at runtime from `dev` (never from `task/*`), capped at 4 specialists per diff + `spec-parity-reviewer`. |
| **Persona UX Gate (`user-advocate`)** | *Porte UX orientée personas (`user-advocate`)* | Specialist evaluating end-user journeys in `design-gate` mode (enriching ticket acceptance criteria before `/epure approve`) and `implementation-review` mode (blocking PR check on UI changes). |
| **Blocking Design Violation (`impeccable-gate`)** | *Violation de design bloquante* | Objective new UI regression (WCAG 2.1 AA contrast, layout overflow, missing `DESIGN.md` tokens, or missing `loading`/`ready`/`error` interaction states) that blocks PR merge. |
| **AI Semantic Squash Synthesis** | *Synthèse de message de squash sémantique par IA* | Zero-temperature generation of a Conventional Commit title and body right before squash-merge (`Refs #<ticket>` on `feature/*`, `Closes #<issue>` on `dev`). |

---

## 4. Multi-Provider LLM Router & Structured Output (ADR-0029)

| English Term | French Canonical Term (`GLOSSARY.md`) | Definition & Invariant |
| --- | --- | --- |
| **Multi-Provider LLM Router (`LLMClient`)** | *Routeur LLM multi-fournisseurs* | Dependency-free TypeScript HTTP client routing `<provider>/<model>` identifiers (`openai/`, `azure/`, `azure_ai/`, `google/`, `gemini/`, `anthropic/`, or named aliases in `.github/agents.yml` with lazy `os.environ/VAR_NAME` resolution) without cross-provider fallback on auth/quota errors (ADR-0012). |
| **Schema-Enforced Structured Output (`ResponseSchemaSpec<T>`)** | *Sortie structurée par schéma* | Contract pairing a strict JSON Schema (`responseSchema`, `response_format.json_schema`, or `output_config.format`) with a runtime TypeScript validator, executing a 2-phase tool loop + schema-locked final turn on Google Gemini. |
| **Contextual `/epure` Command Cheat-Sheet (`formatEpureCommandsSpoiler`)** | *Aide-mémoire contextuel des commandes `/epure`* | Collapsible `<details>` block appended to every EPURE issue comment, sub-issue body, and PR description summarizing available commands and highlighting the recommended next action for the current phase. |

