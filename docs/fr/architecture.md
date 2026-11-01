# Modèle d'Architecture, de Sécurité & de Revue Multi-Agents

EPURE a été conçu dès l'origine autour de trois principes d'ingénierie : **Défense en Profondeur**, **Moindre Privilège** et **État Déterministe Hors-Branches**. Chaque frontière d'automatisation est garantie à la fois par les GitHub Repository Rulesets et par l'isolation d'exécution locale.

> **Schéma Interactif du Pipeline Événementiel & Custom Actions** : Consultez le [diagramme `epure-ci-actions-flow` dans la Référence des Commandes](./commands#2-pipeline-evenementiel-github-actions-custom-actions-epure-ci-actions-flow) pour visualiser l'enchaînement complet des événements GitHub (`issue_comment`, `check_suite`, `workflow_run`, `pull_request`, `workflow_dispatch`), du contrôle sans secret `authorize-command`, du job isolé `orchestrate-command` (`environment: <llm-env>`) et de la promotion `release`.

---

## 1. Architecture de Sécurité & Frontières de Confiance

<ArchifyDiagram
  slug="epure-security-architecture"
  locale="fr"
  title="Architecture de Sécurité & Frontières de Confiance d'EPURE"
  caption="Schéma d'architecture interactif illustrant le Plan de Contrôle de Confiance, la Sandbox Sans Secret, l'État Git CAS et les 2 GitHub Apps."
/>

### Invariants Architecturaux Clés

1. **Séparation à Deux GitHub Apps & Secrets Cloisonnés par Environnement (`<owner>-epure-agent` vs `<owner>-epure-release`, Q82 & Q91)** :
   - L'**Agent App** émet des jetons d'installation RS256 éphémères dédiés à l'orchestration quotidienne (`plan/*`, `task/*`, `feature/*`). Ses identifiants (`EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`) et `LLM_API_KEY` sont isolés dans l'environnement GitHub d'agent (`<llm-env>`) et ne sont jamais exposés à `authorize-command` ni aux workflows publics de Pull Request. Elle n'est Bypass Actor **que** sur le ruleset `epure-feature-governance` (`refs/heads/feature/*`), ce qui lui permet de fusionner en autonomie les tâches atomiques validées tout en lui interdisant matériellement de fusionner du code applicatif dans `dev` ou de pousser sur `main`.
   - La **Release App** est invoquée exclusivement par `release-promote.yml` / `release.yml` sur déclenchement humain (`workflow_dispatch`) au sein de l'environnement GitHub protégé `release` (`EPURE_RELEASE_APP_ID`, `EPURE_RELEASE_APP_PRIVATE_KEY`). C'est le seul Bypass Actor autorisé sur `epure-release-immutability` (`refs/heads/main` et `refs/tags/v*`).
2. **Exécution en Sandbox Sans Secret (Q74)** :
   - Lorsqu'EPURE exécute `npm test`, `npm run build` ou `pytest` sur une branche `task/*`, l'environnement des sous-processus est intégralement purgé de `LLM_API_KEY`, `EPURE_AGENT_APP_PRIVATE_KEY` et `EPURE_RELEASE_APP_PRIVATE_KEY`.
   - Un test ou une dépendance compromise ne peut exfiltrer aucun secret. Si l'isolation de la sandbox ne peut être garantie, EPURE s'arrête immédiatement en mode **fail-closed**.
3. **État Atomique Hors-Branches (`refs/epure/state/<issue>`, Q76)** :
   - Les transitions d'état (`last_processed_comment_id`, `spec_sha` signé, compteurs de tentatives, table des tickets et sous-phases de continuation CI) sont stockées sous forme d'objets Git dans `refs/epure/state/<issue-number>` mis à jour par Compare-And-Swap (`git update-ref`).
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
   - Les définitions des reviewers (`<reviewers_dir>/*.md`, par défaut `.agents/reviewers/*.md`) sont **toujours** lues depuis la branche de confiance `dev` (avec repli sur les templates canoniques embarqués d'EPURE), jamais depuis la branche non fiable `task/*` inspectée.
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
   - Les appels LLM structurés du système (`GrillRoundEvaluation`, `GeneratedPlanningBundle`, `GeneratedTicketImplementation`, constats des reviewers, `user-advocate` et synthèse de squash) transmettent un JSON Schema natif (`responseSchema`, `response_format.json_schema` avec fermeture récursive `additionalProperties: false`, ou `output_config.format`) couplé aux validateurs TypeScript de `src/orchestrator/prompts/schemas.ts`.
   - Sur Google Gemini, lorsqu'un appel combine les outils d'exploration (`list_repo_files`, `search_in_repo_file`, `read_repo_file`) et un schéma JSON, la **Phase 1** exécute les tours d'outils avec `functionDeclarations` (en préservant les `thoughtSignature` Gemini 3), puis la **Phase 2** verrouille `functionCallingConfig.mode = "NONE"` avec `responseMimeType: "application/json"` et `responseSchema`.
3. **Architecture Modulaire `src/orchestrator/` & Garde-fous Branchés** :
   - `src/orchestrator/issue-orchestrator.ts` orchestre les sous-modules spécialisés `github/rest-client.ts`, `workspace/repo-tools.ts`, `prompts/schemas.ts`, `formatting/comments.ts` ainsi que les 3 phases `phases/grill-and-plan.ts`, `phases/ticket-execution.ts` et `phases/feature-integration.ts`.
   - Branche directement la détection de cycles du DAG (`validatePlanningArtifactsAndGraph`), le déblocage sur dépendance prouvée (`reconcileProvenTicketDependencies`, escaladant en `needs-human` si un ticket bloquant est fermé en `not_planned`), la détection d'annulation `/epure cancel` inter-tickets (`processPendingIssueCommentsBatch`) et la garde anti-boucle de revue par SHA (`evaluateReviewFeedbackTrigger`).

---

## 4. Pipeline de Vérification en 3 Étapes, Sandbox Noyau Ubuntu 26.04 & Continuation CI Événementielle (ADR-0028, ADR-0030, ADR-0031)

1. **Stage 1 — Sandbox Noyau Linux en 2 Phases, Condensation `rtk` Sans État & Isolation Goldfish par Ticket** :
   - S'exécute sur `ubuntu-26.04` (noyau Linux 7.0) dans un clone Git local persistant avant toute publication sur `task/*` :
     - **Phase A (`install`, `networkPolicy: "https_only"`)** : exécute l'installation des dépendances sous `landrun` (Landlock ABI v8) en restreignant le trafic TCP sortant au seul port `443` et les écritures à `workDir`, `/tmp` et aux caches de paquets.
     - **Phase B (`codegen`, `typecheck`, `lint`, `test`, `build`, `networkPolicy: "offline"`)** : exécute les vérifications totalement hors-ligne sous `bubblewrap` (`bwrap --unshare-net --unshare-pid --unshare-ipc --tmpfs /tmp --die-with-parent`, avec repli automatique sur `landrun` hors-ligne).
   - **Condensation sans état `rtk` (`formatAndCondenseStage1CommandOutput`)** : filtre les séquences ANSI, barres de progression et journaux verbeux en mode 100 % sans état (`RTK_TELEMETRY_DISABLED=1`, `RTK_RECALL=0`, `RTK_TEE=0`, aucune base SQLite) tout en conservant les 4 000 derniers caractères bruts de la pile d'erreur dès que `exit_code !== 0`.
   - **Synchronisation Git 3-way (`/epure sync`) & Isolation Goldfish** : maintient `dev -> feature/* -> task/*` synchronisés avec résolution 3-way assistée par LLM et validée par le Stage 1, et exécute chaque ticket dans une session Goldfish isolée sans mémoire des tickets précédents (`runGoldfishSpecAudit` lors de `/epure to-spec`).
2. **Stage 2 — Continuation Événementielle de la CI Externe (`waiting_ticket_ci` / `waiting_feature_ci`)** :
   - Dès que le Stage 1 réussit et que la Pull Request `task/* -> feature/*` ou `feature/* -> dev` est ouverte avec son check `ai-review`, EPURE persiste `subphase: "waiting_ticket_ci"` (ou `"waiting_feature_ci"`), `active_pr_number` et `active_head_sha` dans `refs/epure/state/<issue>`, puis termine immédiatement le job avec le code `0` (`async_ci_continuation: true`).
   - Aucun runner GitHub Actions ne reste bloqué en attente passive. Lorsque GitHub émet `check_suite.completed` ou `workflow_run.completed` (ou qu'un mainteneur poste `/epure continue`), EPURE reprend exactement à l'état persisté.
3. **Stage 3 — Roster de Revue Multi-Agents depuis `dev` & Squash Sémantique IA** :
   - Corrèle le résultat des workflows CI externes avec le panel de reviewers spécialisés chargé depuis `dev`. En cas d'échec CI ou de constat `must_fix`, EPURE extrait les journaux d'erreur assainis (~12 Ko) et exécute jusqu'à `max_code_fix_attempts = 3` rondes de remédiation unifiées avant de fusionner `task/* -> feature/*` par squash sémantique IA.

---

## 5. Outils de Mutation Incrémentale, Garde d'Intégrité Inter-Tickets & Convergence Multi-Phases (ADR-0032, ADR-0033)

1. **Mutation Incrémentale Transactionnelle (`StagedTicketImplementationBuffer`)** :
   - Pendant l'implémentation et la remédiation d'un ticket, le modèle modifie les fichiers de manière incrémentale via `write_repo_file`, `patch_repo_file` et `delete_repo_file` dans un tampon transactionnel en mémoire (`StagedTicketImplementationBuffer`), isolé de `feature/*` tant que `validateWorkspaceFileOperations`, `validateTicketIntegrityGuard` et le Sandbox Stage 1 n'ont pas validé l'ensemble.
   - **Repli Segmenté Fichier par Fichier (`ChunkedTicketImplementationFallback`)** : si un ticket multi-fichiers rencontre une troncature `MAX_TOKENS`, EPURE décompose automatiquement les entrées `filesToTouch` restantes en sous-appels fichier par fichier (en conservant les mutations déjà validées dans le tampon et en annulant tout le tampon sans commit partiel si un sous-appel échoue).
   - **Catalogue Compact de Contexte (`CompactWorkspaceFilesContext`)** : injecte le contenu complet (sans aucune troncature au milieu d'un fichier) uniquement pour les fichiers modifiés par le ticket ou listés dans `filesToTouch`, et expose le reste du dépôt sous forme d'un index `chemin (N lignes)` consultable à la demande via `read_repo_file` et `search_in_repo_file`.
2. **Graphe Relationnel GitHub Natif, Garde d'Intégrité Inter-Tickets & Réconciliation Sémantique des ADRs** :
   - `/epure to-tickets` câble nativement les liens `sub_issues` et `dependencies/blocked_by` dans GitHub en complément de la Tasklist Markdown de l'issue de pilotage.
   - `validateTicketIntegrityGuard` interdit à tout ticket de supprimer ou vider des fichiers de test existants, de tronquer plus de 30 % des lignes/symboles d'un fichier hors périmètre, ou de dégrader les scripts `build`/`test`/`lint`/`typecheck` des manifestes en commandes factices.
   - `renumberCollidingAdrs` et `reconcileAdrsWithLlm` dédupliquent les ADRs par slug entre branches concurrentes, renumérotent de façon monotone les fichiers `docs/adr/NNNN-*.md` en collision et alignent les références croisées dans les spécifications et `GLOSSARY.md`.
3. **Audit de Convergence Zéro-Contexte (`EpicConvergenceAudit`) & Remédiation Multi-Phases (`max_epic_phases`)** :
   - Avant d'ouvrir la PR finale `feature/* -> dev`, une session isolée zéro-contexte (`runEpicConvergenceAudit`) vérifie la branche de fonctionnalité face à l'`EpicGoalContract` de la spécification (`required_entrypoints`, absence de `forbidden_stubs` et `end_to_end_verification_criteria`).
   - Si des points d'entrée non câblés ou des simulacres sont détectés (`verdict: "INCOMPLETE"`) et que `epic_phase < max_epic_phases` (`2` par défaut), EPURE génère, chaîne et exécute automatiquement des **tickets de convergence de Phase 2** (`[Phase 2 - Ticket N]`) avant d'ouvrir la PR finale ; au-delà du plafond, il escalade en `epic_convergence_exhausted` (`needs-human`).
