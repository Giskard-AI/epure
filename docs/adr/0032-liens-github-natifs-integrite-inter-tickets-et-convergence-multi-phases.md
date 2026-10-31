---
status: accepted
---
# ADR-0032 : Graphe relationnel GitHub natif, garde-fous d'intégrité inter-tickets, réconciliation sémantique des ADRs et convergence multi-phases zéro-contexte

- **Statut** : Accepté
- **Date** : 2026-10-31
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0001, ADR-0002, ADR-0003, ADR-0012, ADR-0017, ADR-0024, ADR-0027, ADR-0028, ADR-0031

## Contexte

L'audit d'exécutions d'`EPURE` sur des dépôts polyglottes comportant plusieurs **Issues de pilotage** et **Tickets d'implémentation** met en évidence quatre vulnérabilités architecturales :

1. **Absence de Graphe relationnel GitHub natif (`Q112`)** :
   - Lors de `/epure to-tickets`, l'**Éditeur privilégié** écrivait uniquement du texte Markdown (`blocked_by: #N`) sans appeler les APIs REST natives de GitHub (`sub_issues` et `dependencies/blocked_by`) ni maintenir une Tasklist dans le corps de l'**Issue de pilotage**. Les utilisateurs humains ne voyaient donc ni la hiérarchie parent-enfant ni les badges natifs de blocage dans l'interface GitHub.
2. **Risque de corruption inter-tickets et de dégradation des commandes de vérification (`Q113`)** :
   - Un **Ticket d'implémentation** ultérieur pouvait supprimer par erreur un fichier de test existant hérité de `dev` ou d'un ticket précédent, amputer massivement un module partagé hors de son périmètre déclaré (`filesToTouch`), ou remplacer un script de vérification (`build`, `test`, `lint`, `typecheck`, `check`) dans un manifeste (`package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `Justfile`) par une commande factice (`echo ...`, `true`) ou un simple alias de test unitaire.
3. **Prolifération de doublons d'ADRs et dérive documentaire lors des synchronisations concurrentes (`Q114` & `Q118`)** :
   - Lors de synchronisations répétées entre `dev` et `feature/*`, `renumberCollidingAdrs` comparait uniquement les numéros `NNNN` sans dédupliquer par `<slug>` ni vérifier la cohérence sémantique croisée avec les nouveaux ADRs apparus sur `dev`, générant des triplons d'une même décision sous plusieurs numéros successifs.
4. **Implémentations insulaires (« *Island Code* ») et absence de convergence de bout en bout (`Q115`, `Q116`, `Q117`, `Q119`, `Q120`, `Q121`)** :
   - Des modules ou composants validaient leurs tests unitaires isolés dans chaque **Branche de ticket** (`task/*`) sans câbler les points d'entrée réels du dépôt consommateur, ou laissaient des adaptateurs factices en mémoire au lieu des adaptateurs de production requis par la spécification. L'orchestrateur ouvrait directement la Pull Request finale `feature/* -> dev` sans exécuter d'audit holistique de convergence ni déclencher une seconde phase corrective de tickets.

## Décisions

### 1. Graphe relationnel GitHub natif tolérant aux pannes (`Q112`)

- Lors de `/epure to-tickets` et lors de la génération de tickets de **Phase de convergence corrective (`Phase 2 de tickets`)**, l'**Éditeur privilégié** capture l'identifiant numérique de base de données (`issue.id`) retourné par `POST /repos/{owner}/{repo}/issues`.
- Pour chaque **Ticket d'implémentation** créé :
  1. L'orchestrateur rattache le ticket comme sous-issue native de l'**Issue de pilotage** via `POST /repos/{owner}/{repo}/issues/{parent}/sub_issues` (`{ sub_issue_id: childDbId }`).
  2. Pour chaque **Dépendance bloquante** (`blocked_by_indices`), l'orchestrateur enregistre la dépendance native via `POST /repos/{owner}/{repo}/issues/{child}/dependencies/blocked_by` (`{ issue_id: blockerDbId }`).
  3. L'orchestrateur met à jour de façon idempotente une section délimitée `<!-- epure-tickets-tasklist:start --> ... <!-- epure-tickets-tasklist:end -->` dans le corps de l'**Issue de pilotage** (`PATCH /repos/{owner}/{repo}/issues/{parent}`) regroupant les tickets par phase (`### Plan Tickets (Phase 1)`, puis `### Remediation Tickets (Phase 2)`).
- Le client REST GitHub exécute ces appels relationnels en mode tolérant aux pannes : QUAND GitHub renvoie une erreur HTTP (`404`, `422`, `5xx`), ALORS le client journalise ou ignore l'erreur sans interrompre l'orchestration, tandis que la **Référence Git d'état d'orchestration** (`refs/epure/state/<issue>`) et le manifeste `<!-- epure-plan-manifest:... -->` demeurent l'unique source d'autorité de l'orchestrateur (ADR-0024).

### 2. Garde-fou d'intégrité inter-tickets agnostique (`validateTicketIntegrityGuard`, `Q113`)

- Avant tout commit sur une **Branche de ticket** (`task/*`), l'orchestrateur exécute `validateTicketIntegrityGuard` pour comparer l'état proposé par rapport à la **Branche de fonctionnalité** (`feature/*`) selon trois invariants agnostiques :
  1. **Protection des suites de tests existantes (`unauthorized_test_deletion`)** : le garde-fou `validateTicketIntegrityGuard` bloque toute suppression ou tout vidage d'un fichier de test existant sur `feature/*` ou `dev` lorsque le périmètre du ticket ne désigne pas explicitement ce fichier comme cible à supprimer ou remplacer.
  2. **Anti-troncature hors périmètre (`out_of_scope_file_truncation`)** : le garde-fou `validateTicketIntegrityGuard` rejette toute modification d'un fichier existant de 15 lignes ou plus hors de `ticket.filesToTouch` (hors voisin direct d'export `index.*`, `mod.rs`, `lib.rs`, `__init__.py`) qui supprime plus de 30 % de ses lignes non vides ou de ses déclarations publiques/exportées.
  3. **Protection des commandes de vérification (`verification_script_degradation`)** : dans tout manifeste d'orchestration ou de paquet (`package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `Justfile`), le garde-fou `validateTicketIntegrityGuard` interdit de remplacer une commande existante de `build`, `test`, `lint`, `typecheck` ou `check` par une commande inerte (`echo`, `true`, `:`) ou de rediriger la cible `build` vers la même commande de test unitaire que `test`.
- QUAND `validateTicketIntegrityGuard` détecte une violation, ALORS l'orchestrateur bloque le commit, restaure les fichiers de base altérés et lance une ronde de remédiation locale du ticket (imputée sur `max_code_fix_attempts = 3`) avec le diagnostic structuré des violations.

### 3. Réconciliation sémantique et monotone des ADRs (`Q114` & `Q118`)

- La fonction `renumberCollidingAdrs` indexe les ADRs de `dev` et de `feature/*` à la fois par numéro (`NNNN`) et par `<slug>` normalisé (`docs/adr/NNNN-<slug>.md`) :
  - **Déduplication par slug** : QUAND un ADR de `plan/*` ou `feature/*` possède le même `<slug>` qu'un ADR déjà présent sur `dev`, ALORS `renumberCollidingAdrs` réutilise le numéro et le chemin canoniques de `dev` et ajoute tout ancien chemin renuméroté à `deletedAdrPaths`.
  - **Renumérotation monotone sur collision de numéro** : QUAND deux ADRs de `<slug>` différents entrent en collision sur le même numéro `NNNN`, ALORS `renumberCollidingAdrs` attribue `max(dev, feature) + 1` à l'ADR entrant, ajoute son ancien chemin à `deletedAdrPaths` et met à jour toutes les références `ADR-NNNN` dans les ADRs, `docs/specs/*.md` et `GLOSSARY.md` en une passe atomique.
- QUAND une synchronisation (`integratePlanBranchIntoFeature` ou `syncBranchWithBase`) détecte que `dev` comporte des ADRs concurrents ou en collision avec `feature/*` et qu'un client LLM est disponible, ALORS l'orchestrateur exécute `reconcileAdrsWithLlm` (`ADR_COHERENCE_RECONCILIATION_SCHEMA`) pour vérifier la cohérence croisée, fusionner deux ADRs traitant de la même décision sous deux slugs distincts et aligner les références dans `docs/specs/*.md` et `GLOSSARY.md`.

### 4. Contrat de convergence de fonctionnalité (`EpicGoalContract`), Audit zéro-contexte et Phase 2 automatique (`Q115`–`Q121`)

- Dès `/epure to-spec`, le schéma `GENERATED_SPEC_ARTIFACTS_SCHEMA` produit un **Contrat de convergence de fonctionnalité (`EpicGoalContract`)** agnostique (`epic_goal_summary`, `required_entrypoints`, `forbidden_stubs`, `end_to_end_verification_criteria`), que l'**Auditeur de spécification Goldfish zéro-contexte** (`runGoldfishSpecAudit`) vérifie et que l'orchestrateur persiste dans `<!-- epure-plan-manifest:... -->`.
- Lors de `/epure to-tickets`, tout plan comportant plusieurs tickets inclut un ticket terminal d'intégration (bloqué par les tickets de composants) qui câble les `required_entrypoints` et vérifie les `end_to_end_verification_criteria`.
- La méthode `readBranchWorkspaceFiles` épingle dynamiquement (dans une limite de 35 % du budget mémoire) les manifestes déclarés dans `verification.targets` ainsi que les chemins de `required_entrypoints` et `filesToTouch`, et l'orchestrateur ne tronque aucun fichier fourni dans les prompts LLM (fournissant soit le contenu intégral du fichier, soit les outils d'exploration en lecture seule `read_repo_file`, `search_repo_code`, `search_in_repo_file`, `list_repo_files` retournant le contenu intégral non tronqué).
- À la fin de chaque phase de tickets sur `feature/*` et avant `runFeatureIntegrationPhase`, l'orchestrateur exécute `runEpicConvergenceAudit` (`EPIC_CONVERGENCE_AUDIT_SCHEMA`) dans une session LLM **zéro-contexte** dotée des outils d'exploration en lecture seule (`read_repo_file`, `search_repo_code`, `list_repo_files`), du diff complet `dev...feature/*` et du résultat Stage 1 sur `feature/*` :
  - QUAND `verdict === "CONVERGED"`, ALORS l'orchestrateur invoque `runFeatureIntegrationPhase` et inclut le résumé de convergence dans le corps de la Pull Request finale `feature/* -> dev`.
  - QUAND `verdict === "INCOMPLETE"` et `epic_phase < max_epic_phases` (défaut `2`, configurable de `1` à `3` dans `.github/agents.yml`), ALORS l'orchestrateur crée automatiquement les sous-issues GitHub de **Phase 2** (`[Phase 2 - Ticket N] ...`, 1 à 4 tickets) avec leur **Graphe relationnel GitHub natif**, met à jour la Tasklist parente et le manifeste, incrémente `epic_phase` dans `refs/epure/state/<issue>` et relance immédiatement `runTicketExecutionLoop`.
  - QUAND `verdict === "INCOMPLETE"` et `epic_phase >= max_epic_phases`, ALORS l'orchestrateur déclenche une **Escalade humaine** (`needs-human`) avec la raison typée `epic_convergence_exhausted` exposant `unwired_modules`, `stub_violations` et `unmet_criteria`.

## Conséquences

- L'interface GitHub affiche directement aux utilisateurs les sous-issues natives, les badges `Blocked by` et une Tasklist synchronisée par phase sur l'**Issue de pilotage**.
- Le garde-fou `validateTicketIntegrityGuard` et la fonction `renumberCollidingAdrs` bloquent à la source les régressions inter-tickets (suppression accidentelle de tests, troncature de fichiers partagés, dégradation de scripts de build) et les triplons d'ADRs.
- L'auditeur zéro-contexte `runEpicConvergenceAudit` détecte les implémentations insulaires (« *island code* ») avant l'ouverture de la Pull Request finale et déclenche une Phase 2 bornée de tickets correctifs.
