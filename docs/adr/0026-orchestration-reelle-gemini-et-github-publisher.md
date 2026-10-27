---
status: accepted
---
# Orchestration réelle Gemini API, Publisher GitHub App RS256 et persistance Git `refs/epure/state/*`

## Contexte

Les 38 tickets initiaux de la V1.0 d'`EPURE` ont validé l'ensemble des contrats d'interface, des garde-fous de sécurité et des machines d'état via des implémentations en mémoire de test (`createInMemoryGitRefStateStore`, `createDefaultDryPublisherClient`, adaptateurs de test Pi/Codex). Lors de l'exercice réel sur un dépôt consommateur pilote (`my-org/craft-calculator`), le workflow réutilisable `.github/workflows/issue-command.yml` s'arrêtait après la vérification de permissions `authorize-command`, obligeant un agent local à suppléer manuellement la création des branches, des tickets et du code.

Pour qu'un utilisateur humain puisse piloter l'intégralité du cycle de vie uniquement par des commentaires GitHub (`/epure plan`, réponses au grill, `/epure approve`), le Reusable Workflow doit exécuter les transitions de bout en bout sur le runner du dépôt consommateur.

## Décisions (Q84 à Q90)

1. **Q84 — Grammaire unifiée et continuité implicite du grill** :
   - `/epure plan` initialise la phase `grilling` dans `refs/epure/state/<issue>` et déclenche la première ronde de questions de clarification.
   - Tout commentaire humain posté par un collaborateur autorisé (`write`/`admin`) sur une issue dont l'état `refs/epure/state/<issue>` est actif en phase `grilling` est automatiquement routé comme réponse à l'entretien en cours, sans exiger de préfixe `/epure`.
   - Les commandes explicites `/epure status`, `/epure plan`, `/epure to-spec`, `/epure to-tickets`, `/epure approve` et `/epure cancel` sont reconnues nativement.
2. **Q85 — Validation humaine de la frontière de Grill (`/epure to-spec`) et de la spécification (`/epure to-tickets`) avant approbation (raffiné par ADR-0029)** :
   - Lorsque les réponses humaines résolvent les questions ouvertes du grill (`frontier_resolved: true`), l'orchestrateur publie la synthèse des décisions en phase `grilling` (`awaiting_human_approval`) et attend `/epure to-spec` pour commiter sur `plan/<issue>-<slug>` les livrables `GLOSSARY.md`, `docs/adr/0001-*.md`..`NNNN-*.md` et `docs/specs/<slug>.md` (phase `spec` / `awaiting_human_approval`, révisable par commentaires libres), puis `/epure to-tickets` pour créer le DAG de tickets GitHub (`blocked_by`, `ready-for-agent`) en phase `tickets` (`awaiting_human_approval`) avant `/epure approve`.
3. **Q86 — Inférence Gemini via le proxy LLM de sandbox** :
   - L'orchestrateur et le proxy local (`llm-sandbox.ts`) utilisent la clé `LLM_API_KEY` (issue de l'environnement GitHub `gemini`) pour interroger l'API Gemini (`generativelanguage.googleapis.com`) tout en maintenant l'isolation stricte des sous-processus de test et de build (`buildSanitizedSandboxEnv`).
4. **Q87 — Authentification GitHub App RS256 et `GitCliRefStateStore`** :
   - Le publisher échange `EPURE_AGENT_APP_ID` et `EPURE_AGENT_APP_PRIVATE_KEY` contre un jeton d'installation GitHub App éphémère signé en RS256 (`node:crypto`) et scopé au dépôt cible.
   - `GitCliRefStateStore` lit et met à jour atomiquement `refs/epure/state/<issue-number>` sur le dépôt distant via `git fetch` et `git push --force-with-lease`.
5. **Q88 — Exécution autonome du DAG de tickets sur `/epure approve`** :
   - Sur `/epure approve`, l'orchestrateur fusionne `plan/<issue>-<slug>` dans `dev`, crée `feature/<issue>-<slug>`, puis parcourt séquentiellement les tickets prêts du DAG : création de `task/<ticket>-<slug>`, génération TDD (tests unitaires Vitest + implémentation) via Gemini, validation `npm test` & `npm run build` dans la sandbox sans secrets, ouverture de la PR `task/* → feature/*`, publication du check `ai-review`, squash-merge dans `feature/*`, clôture du ticket, puis ouverture de la PR finale `feature/* → dev`.
6. **Q89 & Q90 — Wizard de provisionnement des GitHub Apps et Guide utilisateur** :
   - Un script interactif `scripts/setup-github-apps-wizard.sh` guide l'administrateur humain en 5 étapes pour enregistrer et installer `Agent App` et `Release App` et injecter leurs secrets.
   - Le flux complet est documenté dans `docs/EPURE-WORKFLOW.md`.

## Conséquences

- Un humain (ou un sous-agent jouant strictement le rôle d'un humain sans coder) peut piloter un projet de bout en bout uniquement depuis les issues et PRs GitHub.
- Les 244+ tests unitaires existants continuent de s'exécuter instantanément en mémoire tandis que l'action pré-bundlée `actions/orchestrate-issue` exécute les effets réels sur GitHub Actions.

## Références

Q1, Q2, Q9, Q25, Q34, Q46, Q69, Q74–Q90 ; ADR-0001, ADR-0004, ADR-0009, ADR-0015, ADR-0023, ADR-0024, ADR-0025.
