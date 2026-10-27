# Modèle d'Architecture, de Sécurité & de Revue Multi-Agents

EPURE a été conçu dès l'origine autour de trois principes d'ingénierie : **Défense en Profondeur**, **Moindre Privilège** et **État Déterministe Hors-Branches**. Chaque frontière d'automatisation est garantie à la fois par les GitHub Repository Rulesets et par l'isolation d'exécution locale.

---

## 1. Architecture de Sécurité & Frontières de Confiance

<ArchifyDiagram
  slug="epure-security-architecture"
  locale="fr"
  title="Architecture de Sécurité & Frontières de Confiance d'EPURE"
  caption="Schéma d'architecture interactif illustrant le Plan de Contrôle de Confiance, la Sandbox Sans Secret, l'État Git CAS et les 2 GitHub Apps."
/>

### Invariants Architecturaux Clés

1. **Séparation à Deux GitHub Apps (`<owner>-epure-agent` vs `<owner>-epure-release`, Q82 & Q91)** :
   - L'**Agent App** émet des jetons d'installation RS256 éphémères dédiés à l'orchestration quotidienne (`plan/*`, `task/*`, `feature/*`). Elle n'est Bypass Actor **que** sur le ruleset `epure-feature-governance` (`refs/heads/feature/*`), ce qui lui permet de fusionner en autonomie les tâches atomiques validées tout en lui interdisant matériellement de fusionner du code applicatif dans `dev` ou de pousser sur `main`.
   - La **Release App** est invoquée exclusivement par `release-promote.yml` sur déclenchement humain (`workflow_dispatch`). C'est le seul Bypass Actor autorisé sur `epure-release-immutability` (`refs/heads/main` et `refs/tags/v*`).
2. **Exécution en Sandbox Sans Secret (Q74)** :
   - Lorsqu'EPURE exécute `npm test`, `npm run build` ou `pytest` sur une branche `task/*`, l'environnement des sous-processus est intégralement purgé de `LLM_API_KEY`, `EPURE_AGENT_APP_PRIVATE_KEY` et `EPURE_RELEASE_APP_PRIVATE_KEY`.
   - Un test ou une dépendance compromise ne peut exfiltrer aucun secret. Si l'isolation de la sandbox ne peut être garantie, EPURE s'arrête immédiatement en mode **fail-closed**.
3. **État Atomique Hors-Branches (`refs/epure/state/<issue>`, Q76)** :
   - Les transitions d'état (`last_processed_comment_id`, `spec_sha` signé, compteurs de tentatives, table des tickets) sont stockées sous forme d'objets Git dans `refs/epure/state/<issue-number>` mis à jour par Compare-And-Swap (`git update-ref`).
   - Les branches `dev` et `main` restent 100 % exemptes de commits techniques d'état machine.

---

## 2. Pipeline de Revue Multi-Agents, Porte Impeccable & Squash Sémantique IA

<ArchifyDiagram
  slug="epure-review-pipeline"
  locale="fr"
  title="Pipeline de Revue Multi-Agents, Porte Impeccable & Squash Sémantique IA"
  caption="Chargement du roster depuis la branche de confiance dev, outils d'inspection en lecture seule, porte UI Impeccable et boucle d'auto-remédiation ciblée."
/>

### Fonctionnement du Pipeline de Revue (Q92–Q96)

1. **Chargement du Roster depuis `dev` & Défense Prompt-Injection (OWASP LLM01)** :
   - Les définitions des reviewers (`.cursor/agents/*.md`) sont **toujours** lues depuis la branche de confiance `dev` (avec repli sur les templates canoniques embarqués d'EPURE), jamais depuis la branche non fiable `task/*` inspectée.
   - Tous les diffs de PR, messages de commit et commentaires sont encapsulés dans des balises XML `<untrusted_pr_diff>` ordonnant explicitement au modèle d'ignorer toute instruction cachée dans le diff.
2. **Sélection Dynamique (Jusqu'à 4 Spécialistes + `spec-parity-reviewer`)** :
   - Selon les fichiers modifiés par la PR, EPURE sélectionne jusqu'à 4 reviewers pertinents (`domain-backend-reviewer`, `frontend-reviewer`, `infra-reviewer`, `architecture-reviewer`, `security-reviewer`, `standards-reviewer`, `accessibility-reviewer`, `design-reviewer`, `user-advocate`) en plus du reviewer obligatoire `spec-parity-reviewer`.
3. **Outils d'Inspection du Code en Lecture Seule** :
   - Les reviewers ne sont pas limités au seul diff unifié : ils disposent de 4 outils en lecture seule (`list_files`, `read_file`, `read_line_range`, `search_code`) pour vérifier les appelants, les types et les invariants du domaine dans tout le dépôt.
4. **Auto-Remédiation Ciblée (`max_code_fix_attempts = 3`)** :
   - Si un reviewer émet un constat bloquant (`must_fix`), EPURE applique un correctif ciblé dans la sandbox sans secret puis ne relance **que** les reviewers ayant échoué au tour précédent + `spec-parity-reviewer`.
   - Sur la PR finale de synthèse `feature/* -> dev`, tout correctif passe par une sous-PR `task/review-fix-*` afin de respecter les rulesets.
5. **Synthèse de Squash Sémantique par IA (Q94)** :
   - Juste avant le squash-merge d'une PR validée, un appel à température nulle synthétise un titre Conventional Commit (`type(scope): summary (#PR)`) et un corps structuré (`Refs #<ticket>` sur `feature/*`, `Closes #<issue>` / `Closes #<ticket>` sur `dev`).
6. **Moteurs de Qualité & d'Audit Amont Intégrés** :
   - **[Matt Pocock Agent Skills (`mattpocock/skills`)](https://github.com/mattpocock/skills)** — Skills de cadrage et d'exécution (`grill-with-docs`, `to-spec`, `to-tickets`, `tdd`, `code-review`) épinglés dans `skills-lock.json`.
   - **[Impeccable (`pbakaus/impeccable`)](https://github.com/pbakaus/impeccable)** — Système de design (`DESIGN.md`) et porte de qualité UI / WCAG 2.1 AA (`actions/impeccable`).
   - **[iFixAi (`ifixai-ai/iFixAi`)](https://github.com/ifixai-ai/iFixAi)** — Audit déterministe des trajectoires d'autorisation (`actions/ifixai`).
   - **[Archify (`tt-a1i/archify`)](https://github.com/tt-a1i/archify)** — Schémas d'architecture interactifs validés en qualité showcase (`scripts/archify/`).
   - **[zizmor (`woodruffw/zizmor`)](https://github.com/woodruffw/zizmor)** — Analyse statique de sécurité des workflows GitHub Actions (`actions/zizmor-audit`).
   - **[Renovate (`renovatebot/renovate`)](https://github.com/renovatebot/renovate)** — Mise à jour automatisée des workflows épinglés par SHA et des dépendances (`auto_migrate`).

---

## 3. Routeur `LLMClient` Multi-Fournisseurs, Sorties Structurées & Orchestrateur Modulaire (ADR-0029)

1. **Routeur HTTP Multi-Fournisseurs (`src/llm/`)** :
   - Client TypeScript `LLMClient` sans dépendance externe routant les identifiants `<fournisseur>/<modèle>` vers **Google Gemini** (`google/`, `gemini/`), **OpenAI** (`openai/`), **Azure OpenAI** (`azure/`), **Azure AI Foundry** (`azure_ai/`) et **Anthropic** (`anthropic/`), avec résolution différée `os.environ/VAR_NAME` depuis `.github/agents.yml`.
   - Respect strict de l'ADR-0012 : les erreurs HTTP `401`/`403` (`AuthenticationError`) et `402` (`QuotaExhaustedError`) interrompent immédiatement l'exécution sans bascule silencieuse, tandis que les erreurs transitoires (`408`, `429`, `5xx`) appliquent un backoff exponentiel borné.
2. **Sorties Structurées par Schéma (`ResponseSchemaSpec<T>`) & Boucle d'Outils Gemini en 2 Phases** :
   - Les 11 appels LLM structurés du système (`GrillRoundEvaluation`, `GeneratedPlanningBundle`, `GeneratedTicketImplementation`, constats des reviewers, `user-advocate` et synthèse de squash) transmettent un JSON Schema natif (`responseSchema`, `response_format.json_schema` avec fermeture récursive `additionalProperties: false`, ou `output_config.format`) couplé aux validateurs TypeScript de `src/orchestrator/prompts/schemas.ts`.
   - Sur Google Gemini, lorsqu'un appel combine les outils d'exploration (`list_repo_files`, `search_in_repo_file`, `read_repo_file`) et un schéma JSON, la **Phase 1** exécute les tours d'outils avec `functionDeclarations` (en préservant les `thoughtSignature` Gemini 3), puis la **Phase 2** verrouille `functionCallingConfig.mode = "NONE"` avec `responseMimeType: "application/json"` et `responseSchema`.
3. **Architecture Modulaire `src/orchestrator/` & Garde-fous Branchés** :
   - `src/orchestrator/issue-orchestrator.ts` orchestre les sous-modules spécialisés `github/rest-client.ts`, `workspace/repo-tools.ts`, `prompts/schemas.ts`, `formatting/comments.ts` ainsi que les 3 phases `phases/grill-and-plan.ts`, `phases/ticket-execution.ts` et `phases/feature-integration.ts`.
   - Branche directement la détection de cycles du DAG (`validatePlanningArtifactsAndGraph`), le déblocage sur dépendance prouvée (`reconcileProvenTicketDependencies`, escaladant en `needs-human` si un ticket bloquant est fermé en `not_planned`), la détection d'annulation `/epure cancel` inter-tickets (`processPendingIssueCommentsBatch`) et la garde anti-boucle de revue par SHA (`evaluateReviewFeedbackTrigger`).

