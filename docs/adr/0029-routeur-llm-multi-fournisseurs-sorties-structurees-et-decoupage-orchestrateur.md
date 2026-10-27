---
status: accepted
---
# ADR-0029 : Routeur LLM multi-fournisseurs, sorties structurées par schéma et découpage modulaire de l'orchestrateur

- **Statut** : Accepté
- **Date** : 2026-10-26
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0011, ADR-0012, ADR-0018, ADR-0020, ADR-0026, ADR-0027, ADR-0028

## Contexte

L'orchestration de bout en bout introduite par les ADR-0026, ADR-0027 et ADR-0028 présentait quatre limites structurelles identifiées lors de l'audit d'architecture :

1. **Couplage exclusif à Google Gemini au runtime** : bien que `.github/agents.yml` permette à un mainteneur de déclarer des modèles par phase (`models.planning`, `models.implementation`, `models.review`), l'orchestrateur ignorait ces identifiants à l'exécution et appelait systématiquement un client HTTP spécifique à Google Gemini (`gemini-client.ts`).
2. **Absence de schémas JSON natifs et fragilité de l'extraction par expressions régulières** : sur les 12 appels LLM du système, les 11 appels attendant une structure JSON n'envoyaient aucun schéma formel (`responseSchema`, `response_format.json_schema` ou `output_config.format`) à l'API du fournisseur. De plus, lorsque des outils d'exploration du dépôt (`tools`) étaient attachés à l'appel (6 sites d'implémentation et de revue), le client désactivait complètement `responseMimeType: "application/json"` en raison d'une restriction de l'API Gemini v1beta interdisant l'usage simultané de `functionDeclarations` et `responseMimeType`, puis tentait d'extraire du JSON depuis une réponse texte libre par expression régulière.
3. **Orchestrateur monolithique (~3 950 lignes) et garde-fous non branchés** : `src/orchestrator/issue-orchestrator.ts` regroupait dans un seul fichier le client REST GitHub, les outils d'espace de travail, les prompts, le formatage des commentaires et les trois phases du cycle de vie. Plusieurs garde-fous critiques déjà implémentés dans le dépôt (validation acyclique du DAG `artifacts-gate.ts`, déblocage sur dépendance prouvée `proven-dependency-unblocker.ts`, détection d'annulation en lot `comment-batch-cursor.ts`, garde anti-boucle de revue `review-loop-guard.ts`, boucle bornée `ci-repair-loop.ts`, porte `feature-to-dev-pr.ts`) n'étaient pas appelés par l'orchestrateur réel, tandis que 9 anciens modules de simulation « papier » restaient présents dans `src/`.
4. **Découvrabilité des commandes `/epure` dans les fils GitHub** : les commentaires d'issues, les sous-issues de tickets et les descriptions de Pull Requests publiés par `EPURE` ne rappelaient pas systématiquement les commandes disponibles ni la prochaine action attendue selon la phase courante.

## Décisions

### 1. Routeur LLM multi-fournisseurs (`src/llm/`) inspiré de `giskard-llm` et configuration `providers:` dans `.github/agents.yml`

- Nous introduisons `src/llm/` (`types.ts`, `errors.ts`, `providers/google.ts`, `providers/openai.ts`, `providers/anthropic.ts`, `client.ts`, `index.ts`), un client HTTP TypeScript sans dépendance externe (reposant sur `fetch` natif de Node.js 24 LTS pour préserver les Custom Actions pré-bundlées) inspiré de l'architecture de `giskard-llm`.
- **Routage `<provider>/<model>` et rétrocompatibilité** : `LLMClient` route chaque appel selon le préfixe explicite (`openai/`, `azure/`, `azure_ai/`, `google/`, `gemini/`, `anthropic/`) ou selon un alias déclaré dans la section optionnelle `providers:` de `.github/agents.yml` (`LLMClient.configure` / `LLMClient.configureFromDict`). Les identifiants de modèles sans préfixe (`gemini-*`, `gpt-*`, `o1*`, `o3*`, `o4*`, `claude-*`) continuent d'être inférés automatiquement vers leur fournisseur natif.
- **Spécificités Azure OpenAI et Azure AI Foundry** :
  - `azure/<deployment>` construit l'URL `/openai/deployments/<deployment>/chat/completions?api-version=<version>` avec l'en-tête `api-key`.
  - `azure_ai/<deployment>` cible `/chat/completions` et normalise automatiquement les endpoints `*.services.ai.azure.com` en retirant tout suffixe `/models` hérité afin d'éviter les réponses HTTP 200 vides d'Azure AI Foundry.
- **Résolution différée `os.environ/VAR_NAME` et repli déterministe de clé API** : aucune clé secrète en clair n'est stockée dans `.github/agents.yml`. Les valeurs préfixées par `os.environ/` sont résolues à l'exécution depuis `process.env`. La clé API est résolue selon l'ordre strict : `providers[alias].api_key` $\rightarrow$ variable standard du fournisseur (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_API_KEY`, `AZURE_AI_API_KEY`) $\rightarrow$ `LLM_API_KEY`.
- **Conformité stricte à l'ADR-0012 et immunité d'injection** : chaque requête transite par `executeLlmCallWithResilience` (`src/harness/llm-resilience.ts`). Les erreurs `401`/`403` (`LLM_AUTH_INVALID`) et `402`/`insufficient_quota` (`LLM_QUOTA_EXHAUSTED`) suspendent immédiatement l'exécution sans aucune bascule automatique vers un autre fournisseur ou une autre clé. Les erreurs transitoires (`408`, `429`, `500`, `502`, `503`, `504`) appliquent un backoff borné sans consommer le quota `max_code_fix_attempts` du ticket. La clause d'immunité contre l'injection de prompt est injectée dans l'instruction système de tous les fournisseurs.

### 2. Sorties structurées natives par schéma (`ResponseSchemaSpec<T>`) et boucle d'outils Gemini en 2 phases

- Les 11 appels LLM structurés du système (`GrillRoundEvaluation`, `GeneratedPlanningBundle`, `GeneratedTicketImplementation`, constats des reviewers spécialisés/transverses, `user-advocate` en modes `design-gate` et `implementation-review`, synthèse Conventional Commit de squash) utilisent un contrat `ResponseSchemaSpec<T>` associant un JSON Schema formel et un validateur TypeScript d'exécution (`src/orchestrator/prompts/schemas.ts`), éliminant toute extraction heuristique par expression régulière.
- **Fermeture récursive des schémas d'objets** : pour OpenAI, Azure OpenAI et Azure AI Foundry (`response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`), ainsi que pour Anthropic (`output_config: { format: { type: "json_schema", schema } }`), le traducteur applique récursivement `additionalProperties: false` et la liste explicite `required` sur chaque nœud `type: "object"`.
- **Protocole en 2 phases sur Google Gemini (outils + schéma)** :
  - Lorsqu'un appel Gemini combine des outils d'exploration (`list_repo_files`, `search_in_repo_file`, `read_repo_file`) et un `responseSchema`, la **phase 1** exécute la boucle d'appels d'outils avec `tools: [{ functionDeclarations }]` (sans `responseMimeType`), tout en préservant les signatures de réflexion Gemini 3 (`thoughtSignature` ou la sentinelle base64 `c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=`).
  - Dès que le modèle termine ses appels d'outils (ou atteint `maxToolRounds`), la **phase 2** déclenche un tour final dédié avec `toolConfig: { functionCallingConfig: { mode: "NONE" } }`, `responseMimeType: "application/json"` et `responseSchema`, garantissant une sortie JSON strictement conforme au schéma.

### 3. Découpage modulaire de l'orchestrateur, branchement des garde-fous réels (Bucket A) et suppression des stubs obsolètes (Bucket B)

- Le monolithe `src/orchestrator/issue-orchestrator.ts` est découpé en modules spécialisés tout en préservant sa façade publique d'export :
  - `src/orchestrator/types.ts` : contrats et interfaces partagés de l'orchestrateur.
  - `src/orchestrator/github/rest-client.ts` : client REST/Git GitHub, vérification de la frontière de merge du publisher (`verifyPublisherMergeBoundary`) et utilitaires de nommage.
  - `src/orchestrator/workspace/repo-tools.ts` : outils d'exploration en lecture seule, applicateur de patchs et exécution des vérifications Stage 1 en workspace isolé.
  - `src/orchestrator/prompts/schemas.ts` : schémas JSON stricts et validateurs d'exécution des 11 appels LLM structurés.
  - `src/orchestrator/formatting/comments.ts` : constructeurs Markdown des commentaires d'issues, sous-issues, descriptions de PR et spoilers `/epure`.
  - `src/orchestrator/phases/grill-and-plan.ts` : phase de cadrage (`/epure plan`, réponses au grill, `/epure to-spec`, `/epure to-tickets`) branchant `processPendingIssueCommentsBatch` (`comment-batch-cursor.ts`) et `validatePlanningArtifactsAndGraph` (`artifacts-gate.ts`) avant toute création de sous-issues pour bloquer les cycles du DAG (`TICKET_GRAPH_CYCLE_DETECTED`) et les artefacts incomplets.
  - `src/orchestrator/phases/ticket-execution.ts` : phase d'exécution des tickets (`/epure approve`) branchant la détection d'annulation inter-tickets (`/epure cancel` / `/epure stop`), la réconciliation de dépendances prouvées `reconcileProvenTicketDependencies` (`proven-dependency-unblocker.ts` — refusant tout déblocage sur `"not_planned"` et escaladant en `needs-human`), la garde anti-boucle de revue `evaluateReviewFeedbackTrigger` (`review-loop-guard.ts`) et la boucle bornée `runBoundedCiRepairLoop` (`ci-repair-loop.ts`).
  - `src/orchestrator/phases/feature-integration.ts` : phase d'intégration finale `feature/* -> dev` branchant `prepareFeatureToDevPullRequest` (`feature-to-dev-pr.ts`), la revue de synthèse et la réconciliation idempotente.
- Les 9 anciens modules de simulation « papier » non branchés et supplantés par l'architecture réelle (`skill-router.ts`, `execution-dispatch.ts`, `feature-integration-queue.ts`, `task-pr-automerge.ts`, `idempotent-resume-and-cancel.ts`, `bugfix-tdd-gate.ts`, `feature-dev-sync.ts`, `feature-integration-dev-gate.ts`, `feature-regression-and-escalation.ts`) ainsi que leurs tests unitaires simulés sont supprimés du dépôt afin de maintenir une source de vérité unique.

### 4. Aide-mémoire contextuel des commandes `/epure` (`<details>`)

- Chaque commentaire d'issue (rondes de grill, manifeste de spec et tickets, tableau de statut, confirmation d'annulation, escalade `needs-human`, clôture finale), chaque sous-issue de ticket et chaque description de Pull Request (`plan/* -> dev`, `task/* -> feature/*`, `feature/* -> dev`) générés par `EPURE` intègrent au pied du message un bloc repliable `<details>` produit par `formatEpureCommandsSpoiler`.
- Ce bloc récapitule les commandes disponibles (`/epure plan`, `/epure to-spec`, `/epure approve`, `/epure status`, `/epure cancel`) et met en évidence la prochaine action attendue selon la phase courante (`grilling`, `tickets`, `implementation`, `suspended`, `cancelled`, `completed`).

## Conséquences

- Les mainteneurs peuvent combiner librement les modèles d'Anthropic, OpenAI, Azure OpenAI, Azure AI Foundry et Google Gemini par phase dans `.github/agents.yml` tout en conservant les garanties d'isolation de la sandbox sans secret et l'interdiction de fallback financier (ADR-0012).
- La validation par JSON Schema natif et la boucle Gemini en 2 phases éliminent les échecs de parsing JSON au cours des exécutions autonomes avec outils.
- Le branchement effectif des garde-fous de graphe, de dépendances prouvées et d'annulation inter-tickets garantit l'arrêt sûr en cas de cycle, d'abandon de ticket amont (`not_planned`) ou de commande `/epure cancel`.

## Références

ADR-0011, ADR-0012, ADR-0018, ADR-0020, ADR-0026, ADR-0027, ADR-0028 ; `GLOSSARY.md` ; `docs/specs/llm-router-and-orchestrator-modularization.md`.
