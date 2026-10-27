# Specification — Routeur LLM Multi-Fournisseurs, Sorties Structurées par Schéma et Modularisation de l'Orchestrateur

## Problem Statement

Un mainteneur de dépôt consommateur d'`EPURE` configure dans `.github/agents.yml` les modèles de son choix par phase (`models.planning`, `models.implementation`, `models.review`), pouvant appartenir à différents fournisseurs (Anthropic, OpenAI, Azure OpenAI, Azure AI Foundry, Google Gemini). Or, l'orchestrateur actuel ignore ces paramètres au runtime et appelle uniquement un client HTTP spécifique à Google Gemini.

De plus, sur les 12 appels LLM du système, les 11 appels qui attendent une structure de données JSON n'envoient aucun schéma JSON (`responseSchema` / `json_schema`) à l'API du fournisseur. Pire, lorsque des outils d'exploration du dépôt (`tools`) sont attachés à l'appel (6 sites d'appel d'implémentation et de revue), le client désactive complètement le mode JSON à cause d'une limitation de l'API Gemini v1beta, puis tente d'extraire du JSON depuis une réponse texte libre par expressions régulières. Cela expose l'orchestrateur à des erreurs de syntaxe JSON, des clés manquantes ou des types invalides en plein milieu d'un cycle autonome.

Par ailleurs, la logique d'orchestration est concentrée dans un fichier monolithique de près de 4 000 lignes qui mélange le client REST GitHub, les outils d'espace de travail, les prompts, le formatage des commentaires et les trois phases du cycle de vie, tout en laissant de côté plusieurs garde-fous critiques déjà écrits dans le dépôt (détection de cycles dans le graphe de tickets, vérification de résolution prouvée des dépendances bloquantes, détection d'annulation `/epure cancel` entre deux tickets) et en conservant d'anciens modules simulés devenus obsolètes. Enfin, les commentaires d'issues et les descriptions de Pull Requests publiés par l'orchestrateur ne rappellent pas systématiquement les commandes `/epure` disponibles, obligeant l'utilisateur humain à chercher dans la documentation comment interagir, approuver, suspendre ou reprendre le flux.

## Solution

Nous introduisons un **routeur LLM multi-fournisseurs** inspiré de `giskard-llm` (`Giskard-AI/giskard-oss`), sans dépendance externe au runtime afin de préserver les Custom Actions pré-bundlées sur Node.js 24 LTS. Ce routeur résout les identifiants `"provider/model"` (`openai/`, `azure/`, `azure_ai/`, `google/`, `gemini/`, `anthropic/`, ainsi que les alias nommés déclarés dans une section optionnelle `providers:` de `.github/agents.yml` avec résolution différée `os.environ/VAR_NAME`). Chaque phase (`planning`, `implementation`, `review`) utilise le modèle qui lui est configuré tout en respectant strictement l'interdiction de bascule automatique de secours (ADR-0012) et les politiques de résilience (`llm-resilience`).

Chaque appel LLM structuré (11 sites d'appel) utilise désormais une **sortie structurée par schéma** (`ResponseSchemaSpec<T>`) combinant l'application native du JSON Schema chez le fournisseur et une validation d'exécution stricte. Pour Google Gemini, lorsque des outils d'exploration sont fournis simultanément à un schéma de sortie, le client exécute d'abord la boucle d'appels d'outils avec `functionDeclarations`, puis déclenche un tour final dédié (`functionCallingConfig.mode = "NONE"`) avec `responseMimeType: "application/json"` et `responseSchema` activés, garantissant contractuellement une sortie conforme au schéma.

Le monolithe d'orchestration est découpé en modules spécialisés à responsabilité unique (client REST/Git GitHub, outils d'espace de travail et d'application de patchs, schémas et prompts, formatage Markdown, phase de cadrage/planification, phase d'exécution de ticket, phase d'intégration de fonctionnalité), derrière une façade publique inchangée. Les garde-fous réels (validation acyclique du graphe de tickets, déblocage sur dépendance prouvée, détection d'annulation par lot de commentaires, garde anti-boucle de revue et boucle bornée de réparation CI) sont branchés directement dans le flux d'exécution, et les 9 anciens modules de simulation « papier » devenus redondants ou contradictoires avec les ADR récents sont supprimés avec leurs tests simulés.

Enfin, chaque commentaire d'issue, corps de ticket d'implémentation et description de Pull Request publié par `EPURE` intègre un **aide-mémoire contextuel des commandes `/epure`** sous forme de bloc repliable (`<details>`), mettant en évidence la prochaine action recommandée selon la phase courante.

## User Stories

### Routeur LLM multi-fournisseurs et configuration `.github/agents.yml`

1. En tant que mainteneur de projet, je veux déclarer dans `.github/agents.yml` des modèles distincts sous la forme `provider/model` pour les phases `planning`, `implementation` et `review`, afin d'utiliser le meilleur modèle pour chaque tâche.
2. En tant que mainteneur de projet, je veux pouvoir déclarer une section optionnelle `providers:` dans `.github/agents.yml` (avec `provider`, `api_key: os.environ/...`, `base_url: os.environ/...`, `api_version`, `default_headers`), afin de configurer des déploiements Azure OpenAI, Azure AI Foundry ou des endpoints personnalisés sans exposer de secret en clair dans le dépôt.
3. En tant que mainteneur de projet, je veux que les identifiants de modèles sans préfixe (`gemini-*`, `gpt-*`, `o1*`, `o3*`, `o4*`, `claude-*`) continuent d'être routés automatiquement vers leur fournisseur natif, afin de préserver la rétrocompatibilité des fichiers `.github/agents.yml` existants.
4. En tant que mainteneur de projet, je veux que le routeur LLM résolve la clé API selon un ordre déterministe (variable `os.environ/...` de l'alias `providers`, puis variable d'environnement standard du fournisseur comme `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AZURE_API_KEY`, `AZURE_AI_API_KEY`, puis repli sur `LLM_API_KEY`), afin qu'une installation simple à clé unique comme une installation multi-fournisseurs fonctionnent sans friction.
5. En tant qu'administrateur utilisant Azure OpenAI (`azure/<deployment>`), je veux que le client construise automatiquement l'URL `/openai/deployments/<deployment>/chat/completions?api-version=<version>` et l'en-tête `api-key`, afin d'utiliser mes déploiements Azure d'entreprise.
6. En tant qu'administrateur utilisant Azure AI Foundry (`azure_ai/<deployment>`), je veux que le client normalise automatiquement les URLs `*.services.ai.azure.com` (en retirant tout suffixe `/models` hérité), afin d'éviter les réponses HTTP 200 vides sur les endpoints Foundry.
7. En tant que mainteneur soucieux des coûts, je veux qu'aucune erreur d'authentification (`401`/`403`) ou d'épuisement de quota (`402` / `insufficient_quota`) sur le fournisseur configuré pour une phase ne provoque un basculement vers un autre fournisseur (ADR-0012), afin que mes plafonds financiers par fournisseur ne soient jamais contournés.
8. En tant que mainteneur, je veux que les erreurs transitoires (`408`, `429`, `500`, `502`, `503`, `504`) des appels LLM respectent les paramètres `max_transient_api_retries` et `transient_retry_backoff_seconds` de `.github/agents.yml` sans consommer le budget `max_code_fix_attempts` du ticket, afin qu'une instabilité réseau passagère ne fasse pas échouer un ticket en `needs-human`.
9. En tant que responsable sécurité, je veux que la clause d'immunité contre l'injection de prompt soit systématiquement injectée dans l'instruction système de tous les fournisseurs (`google`, `openai`, `azure`, `azure_ai`, `anthropic`), afin que le changement de fournisseur n'abaisse jamais la barrière de sécurité sur les contenus GitHub non fiables.

### Sorties structurées par schéma et boucles d'outils

10. En tant qu'orchestrateur, je veux fournir un schéma JSON strict et un validateur d'exécution à chacun des 11 appels LLM structurés du système, afin qu'aucune étape du workflow ne repose sur de l'extraction JSON fragile par expression régulière.
11. En tant qu'orchestrateur interrogeant OpenAI, Azure ou Anthropic avec un schéma de sortie, je veux que le traducteur du fournisseur ferme récursivement les schémas d'objets (`additionalProperties: false`) et utilise le mécanisme natif (`response_format.json_schema` ou `output_config.format`), afin que le fournisseur garantisse la structure du JSON retourné.
12. En tant qu'orchestrateur interrogeant Google Gemini avec à la fois des outils d'exploration du dépôt (`list_repo_files`, `search_in_repo_file`, `read_repo_file`) et un schéma de sortie structurée, je veux que le client exécute d'abord les tours d'appels d'outils avec `functionDeclarations`, puis effectue automatiquement le tour de conclusion avec `functionCallingConfig.mode = "NONE"`, `responseMimeType: "application/json"` et `responseSchema`, afin de contourner la limitation de l'API Gemini v1beta tout en obtenant un JSON strictement conforme au schéma.
13. En tant qu'orchestrateur utilisant Gemini 3 avec réflexion (`thinkingLevel`), je veux que les signatures de pensée (`thoughtSignature` ou la sentinelle `skip_thought_signature_validator`) soient préservées lors des tours d'outils multi-étapes, afin d'éviter toute erreur de validation Gemini sur l'historique de conversation.
14. En tant qu'orchestrateur en phase de cadrage (`grilling`), je veux que l'évaluation de ronde (`GrillRoundEvaluation`) soit validée par schéma (`frontier_resolved`, `round_number`, `follow_up_questions_markdown`, `rationale`), afin de décider de manière fiable s'il faut poser une nouvelle ronde de questions ou passer à la génération de la spécification.
15. En tant qu'orchestrateur générant le dossier de planification (`GeneratedPlanningBundle`), je veux que la sortie (`plan_slug`, `glossary_markdown`, `adrs`, `spec_path`, `spec_markdown`, `tickets`) soit validée par schéma avant toute écriture sur `plan/*`, afin d'éviter la création de branches ou de tickets incomplets.
16. En tant qu'orchestrateur d'implémentation ou de remédiation de ticket (`GeneratedTicketImplementation`), je veux que la charge utile de code (`commit_message`, `test_summary`, `files`, `patches`, `deleted_files`) soit garantie par schéma, afin que l'applicateur de patchs ne reçoive jamais d'objet malformé.
17. En tant qu'orchestrateur de revue multi-agents et de synthèse de squash commit, je veux que les constats des reviewers (`ReviewerFinding`), la porte UX (`user-advocate`) et le générateur de titre Conventional Commit utilisent également des schémas de sortie natifs, afin d'éliminer tout parsing JSON heuristique dans le sous-système de revue.

### Garde-fous d'orchestration branchés et nettoyage des modules obsolètes

18. En tant que mainteneur, je veux que le dossier de planification généré par le LLM soit vérifié par `validatePlanningArtifactsAndGraph` avant la création des sous-issues GitHub, afin de bloquer immédiatement tout graphe de tickets comportant une dépendance circulaire (`TICKET_GRAPH_CYCLE_DETECTED`) ou des artefacts documentaires vides.
19. En tant que mainteneur, je veux que la boucle d'exécution des tickets (`/epure approve`) ordonne les tickets selon `reconcileProvenTicketDependencies`, afin qu'un ticket dépendant ne démarre jamais tant que ses tickets bloquants ne sont pas résolus de manière prouvée (`state: "closed"` avec `state_reason: "completed"`).
20. En tant que mainteneur, je veux que si un ticket bloquant a été fermé manuellement avec le motif `"not_planned"`, l'orchestrateur refuse de débloquer les tickets dépendants et escalade immédiatement en `needs-human`, afin de ne jamais construire une fonctionnalité sur une fondation annulée.
21. En tant que mainteneur, je veux que pendant l'exécution d'un plan (`/epure approve`), l'orchestrateur vérifie avant chaque ticket (et avant publication) via `processPendingIssueCommentsBatch` et l'état Git `refs/epure/state/<issue>` si un collaborateur autorisé a posté `/epure cancel` ou `/epure stop`, afin d'interrompre proprement le run en cours sans publier de nouveaux effets de bord.
22. En tant que mainteneur, je veux que le déclenchement de la revue multi-agents vérifie `evaluateReviewFeedbackTrigger` sur le `head_sha` courant, afin de ne jamais relancer en boucle une revue automatisée sur un commit déjà évalué.
23. En tant que mainteneur, je veux que l'ouverture de la PR finale `feature/* → dev` vérifie `prepareFeatureToDevPullRequest`, afin de garantir qu'aucun ticket du plan ne reste ouvert et que le corps de la PR récapitule la spécification, les ADR, les tickets résolus et la porte de validation humaine.
24. En tant que développeur d'`EPURE`, je veux que les 9 anciens modules de simulation « papier » devenus redondants ou contradictoires avec les ADR-0026/0027 soient supprimés du dépôt avec leurs tests unitaires simulés, afin qu'il n'existe qu'une seule source de vérité exécutée et testée.

### Modularisation de l'orchestrateur et aide-mémoire `/epure`

25. En tant que développeur d'`EPURE`, je veux que l'orchestrateur d'issues soit découpé en sous-modules clairs (types, client REST/Git GitHub, outils d'espace de travail, schémas de prompts, formatage de commentaires, phase de cadrage/planification, phase d'exécution de ticket, phase d'intégration feature), tout en conservant les exports publics de `issue-orchestrator.ts`, afin que le code soit lisible, maintenable et testable unitairement sans casser l'entrypoint de la Custom Action.
26. En tant qu'utilisateur humain lisant un commentaire d'`EPURE` sur une issue (ronde de grill, manifeste de spec et tickets, statut, annulation, escalade `needs-human` ou clôture finale), je veux trouver en bas du message un bloc repliable `<details>` listant les commandes `/epure` disponibles et mettant en avant la commande recommandée pour la phase courante, afin de savoir immédiatement comment réagir.
27. En tant qu'utilisateur humain inspectant une sous-issue de ticket ou une Pull Request ouverte par `EPURE` (`plan/* → dev`, `task/* → feature/*`, `feature/* → dev`), je veux également voir cet aide-mémoire repliable des commandes `/epure` avec la référence de l'issue de pilotage, afin de pouvoir contrôler, reprendre (`/epure approve`) ou stopper (`/epure cancel`) l'orchestration facilement.

## Implementation Decisions

1. **Architecture du module LLM (`src/llm/`)** :
   * Création d'un module autonome sans dépendance externe au runtime (reposant sur `fetch` natif de Node.js 24 LTS) structuré selon le modèle de `giskard-llm` :
     * `types.ts` : types d'entrée (`ChatMessageParam`, `ToolDefParam`, `ResponseSchemaSpec<T>`, `LLMCompletionOptions<T>`, `ProviderConfig`) et de sortie (`CompletionResponse<T>`, `ToolCall`, `Usage`).
     * `errors.ts` : hiérarchie d'erreurs unifiée (`LLMError`, `AuthenticationError`, `QuotaExhaustedError`, `RateLimitError`, `ServerError`, `LLMTimeoutError`, `BadRequestError`) couplée à `executeLlmCallWithResilience` (`src/harness/llm-resilience.ts`).
     * `providers/google.ts`, `providers/openai.ts`, `providers/anthropic.ts` : traducteurs de requêtes/réponses, normalisation des schémas JSON et gestion des appels d'outils.
     * `client.ts` : classe `LLMClient` supportant `configure(name, config)`, `configureFromDict(dict)`, la résolution différée `"os.environ/VAR_NAME"`, le routage `"provider/model"` (`openai`, `azure`, `azure_ai`, `google`, `gemini`, `anthropic`) et l'inférence automatique du fournisseur pour les noms de modèles nus (`gemini-*` → `google`, `gpt-*`/`o1*`/`o3*`/`o4*` → `openai`, `claude-*` → `anthropic`).
   * Le module `gemini-client.ts` existant est conservé comme simple adaptateur de compatibilité ascendante délégant à `LLMClient`.

2. **Schéma de configuration `.github/agents.yml` pour les fournisseurs LLM** :
   * Le parseur et le sérialiseur de `.github/agents.yml` supportent une section optionnelle `providers:` mappant un nom d'alias (ex. `azure-prod`, `openai`, `google`, `anthropic`) vers `{ provider?, api_key?, base_url?, api_version?, default_headers? }`.
   * Les valeurs préfixées par `os.environ/` sont résolues à l'exécution depuis `process.env`. Aucune clé secrète brute n'est écrite par `setup-repo`.
   * Pour chaque phase (`planning`, `implementation`, `review`), l'orchestrateur sélectionne le modèle déclaré dans `agents.yml` (`config.models.<phase>`), ou à défaut le modèle passé en entrée de l'action (`input.model`, par défaut `google/gemini-3.8-flash`).

3. **Protocole de sortie structurée par schéma et boucle d'outils en 2 phases** :
   * Un contrat `ResponseSchemaSpec<T>` associe un objet `jsonSchema` (JSON Schema standard) et une fonction `validate(raw: unknown): T`.
   * **OpenAI / Azure OpenAI / Azure AI Foundry** : transformation récursive du JSON Schema pour imposer `additionalProperties: false` sur chaque objet (`closeObjectSchemas`) et envoi via `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`.
   * **Anthropic** : envoi du schéma via `output_config: { format: { type: "json_schema", schema } }` sur l'API `/v1/messages` avec fusion automatique des messages système et alternance stricte `user`/`assistant`.
   * **Google Gemini** :
     * Sans outils : envoi direct de `generationConfig.responseMimeType = "application/json"` et `generationConfig.responseSchema`.
     * Avec outils (`tools`) : les tours d'exploration s'exécutent avec `tools: [{ functionDeclarations }]` sans `responseMimeType` (interdit simultanément par Gemini v1beta), en préservant `thoughtSignature` (ou la sentinelle base64 `c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=`). Dès que le modèle termine ses appels d'outils (ou atteint `maxToolRounds`), si la réponse finale n'a pas encore été produite sous contrainte de schéma, un tour de finalisation est exécuté avec `toolConfig: { functionCallingConfig: { mode: "NONE" } }`, `responseMimeType: "application/json"` et `responseSchema`.

4. **Découpage modulaire de l'orchestrateur et branchement des garde-fous** :
   * L'orchestrateur est divisé en sous-modules dédiés sous `src/orchestrator/` :
     * `types.ts` : contrats et interfaces partagés.
     * `github/rest-client.ts` : `createGitHubRestHelper`, `verifyPublisherMergeBoundary`, `slugifyTitle`.
     * `workspace/repo-tools.ts` : `applyTicketImplementationPayload`, `buildRepoExplorationToolsAndHandlers`, `runTestsInIsolatedWorkspace`, `parseTrackedTicketsFromComments`.
     * `prompts/schemas.ts` : les schémas JSON et validateurs stricts pour `GrillRoundEvaluation`, `GeneratedPlanningBundle`, `GeneratedTicketImplementation`, ainsi que les schémas de revue et de squash commit.
     * `formatting/comments.ts` : constructeurs Markdown pour tous les commentaires d'issues, sous-issues, descriptions de PR et l'aide-mémoire repliable `<details>` des commandes `/epure`.
     * `phases/grill-and-plan.ts` : gestion de `/epure plan`, des réponses au grill (pause en `grilling` / `awaiting_human_approval` lorsque `frontier_resolved: true`), de `/epure to-spec` (génération documentaire sur `plan/*` en phase `spec` / `awaiting_human_approval`, avec révision par commentaires libres) et de `/epure to-tickets` (génération du DAG de tickets en phase `tickets` / `awaiting_human_approval`), branchant `processPendingIssueCommentsBatch` et `validatePlanningArtifactsAndGraph`.
     * `phases/ticket-execution.ts` : exécution par ticket branchant la vérification d'annulation inter-tickets, `reconcileProvenTicketDependencies`, `runBoundedCiRepairLoop` et `evaluateReviewFeedbackTrigger`.
     * `phases/feature-integration.ts` : ouverture/réconciliation de la PR `feature/* → dev` branchant `prepareFeatureToDevPullRequest`, la revue de synthèse et la boucle de remédiation finale.
     * `issue-orchestrator.ts` : point d'entrée léger (`orchestrateIssueCommand`) et ré-export des symboles publics.

5. **Suppression des modules de simulation obsolètes** :
   * Suppression des 9 fichiers de simulation non branchés (`skill-router`, `execution-dispatch`, `feature-integration-queue`, `task-pr-automerge`, `idempotent-resume-and-cancel`, `bugfix-tdd-gate`, `feature-dev-sync`, `feature-integration-dev-gate`, `feature-regression-and-escalation`) et de leurs fichiers de tests correspondants.

6. **Aide-mémoire contextuel des commandes `/epure`** :
   * Un générateur `formatEpureCommandsSpoiler({ phase, status, issueNumber })` produit un bloc `<details><summary>⌨️ <b>Commandes <code>/epure</code> disponibles</b> (cliquer pour dérouler)</summary>...</details>` contenant le tableau des commandes (`/epure plan`, `/epure to-spec`, `/epure to-tickets`, `/epure approve`, `/epure status`, `/epure cancel`) et une indication contextuelle sur la prochaine action attendue selon la phase (`grilling`, `spec`, `tickets`, `implementation`, `suspended`, `cancelled`, `completed`).
   * Ce bloc est inclus systématiquement dans tous les commentaires d'issues (y compris les escalades `needs-human` générées par `formatNeedsHumanEscalationComment`), les corps de sous-issues et les corps de PRs créés par l'orchestrateur.

7. **Modèle du domaine (`GLOSSARY.md` et `ADR-0029`)** :
   * Ajout des définitions canoniques dans `GLOSSARY.md` (`Routeur LLM multi-fournisseurs`, `Sortie structurée par schéma`, `Aide-mémoire contextuel des commandes /epure`).
   * Enregistrement de l'ADR-0029 consignant l'architecture du routeur multi-fournisseurs, la résolution en 2 phases outils + schéma sur Gemini, le branchement des garde-fous d'orchestration et la suppression des stubs historiques.

## Testing Decisions

* **Qu'est-ce qu'un bon test** : les tests vérifient uniquement le comportement observable aux frontières publiques (`LLMClient` et `orchestrateIssueCommand`) via des requêtes/réponses HTTP simulées (`fetchImpl`) et des exécutions de sandbox simulées (`sandboxExecImpl`), sans coupler les assertions au découpage interne des fichiers privés.
* **Modules testés** :
  1. `src/llm/` (`tests/llm-client.test.ts`) :
     * Routage `"provider/model"` vers OpenAI, Azure OpenAI (`azure/`), Azure AI Foundry (`azure_ai/` avec normalisation d'URL Foundry), Google Gemini (`google/` et `gemini/`) et Anthropic (`anthropic/`).
     * Configuration `configureFromDict` et résolution différée `os.environ/VAR_NAME` depuis `.github/agents.yml`.
     * Application native des schémas JSON (`responseSchema` / `json_schema` / `output_config`) et validation stricte des objets retournés.
     * Boucle d'outils Gemini suivie du tour final structuré (`mode: "NONE"` + `responseSchema`).
     * Résilience ADR-0012 : suspension immédiate sur `401`/`403` (`LLM_AUTH_INVALID`) et `402` (`LLM_QUOTA_EXHAUSTED`), retries bornés sur `429`/`503`, refus de tout fournisseur de fallback différent.
  2. `src/orchestrator/` (`tests/issue-orchestrator.test.ts` et tests des garde-fous branchés) :
     * Rejet d'un plan contenant un cycle de dépendances (`TICKET_GRAPH_CYCLE_DETECTED` via `validatePlanningArtifactsAndGraph`).
     * Escalade `needs-human` lorsqu'un ticket bloquant est fermé en `"not_planned"` (via `reconcileProvenTicketDependencies`).
     * Arrêt immédiat entre deux tickets lorsqu'un commentaire `/epure cancel` est détecté en cours d'exécution (via `processPendingIssueCommentsBatch`).
     * Présence du bloc `<details>` d'aide-mémoire `/epure` dans les commentaires d'issues, sous-issues, escalades `needs-human` et corps de PRs.
* **Art antérieur dans le dépôt** : tests paramétrés `it.each` dans `tests/issue-orchestrator.test.ts`, `tests/multi-agent-review-and-rulesets.test.ts`, `tests/setup-repo.test.ts` et `tests/llm-resilience.test.ts`.

## Out of Scope

* Publication immédiate de `src/llm/` sur un registre npm externe ou extraction dans un dépôt Git séparé (l'architecture interne de `src/llm/` est prête à être extraite, mais reste bundlée dans le monorepo pour les Custom Actions Node.js 24).
* Ajout de SDK tiers lourds (`openai`, `@anthropic-ai/sdk`, `@google/genai`) dans `dependencies` de `package.json` (tous les appels utilisent `fetch` natif de Node.js 24 LTS).
* Support des embeddings (`aembedding`) ou des API stateful `Responses`/`Interactions` (`aresponse`), dont `EPURE` n'a pas l'usage.

## Further Notes

* La commande `npm run build` (`scripts/build-actions.mjs`) doit être exécutée après le découpage et la mise à jour afin de régénérer les bundles `dist/actions/*/index.mjs` et `dist/cli/setup-repo.mjs` vérifiés par `tests/public-distribution.test.ts`.
