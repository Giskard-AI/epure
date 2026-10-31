---
status: accepted
---
# ADR-0033 : Outils de mutation incrémentale d'espace de travail, repli segmenté fichier par fichier et catalogue compact de contexte

- **Statut** : Accepté
- **Date** : 2026-10-31
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0012, ADR-0028, ADR-0029, ADR-0031, ADR-0032

## Contexte

Lors de l'exécution de **Tickets d'implémentation** multi-fichiers (migrations SQL, routes HTTP et suites de tests paramétrées), le protocole en 2 phases de l'ADR-0029 imposait à l'**Exécuteur d'agent** d'explorer le dépôt en lecture seule pendant la phase 1, puis de sérialiser l'intégralité des fichiers créés ou modifiés dans un unique objet JSON final (`GeneratedTicketImplementation`) en phase 2. Trois limites opérationnelles provoquaient alors une **Escalade humaine** (`needs-human` / `llm_request_invalid`) avant l'ouverture de la Pull Request sur la **Branche de ticket** (`task/*`) :

1. **Goulot d'étranglement de la sortie structurée mono-bloc** : le modèle devait maintenir en mémoire tous les fichiers du ticket et les émettre en un seul tour final, atteignant la limite de jetons de sortie (`MAX_TOKENS`) ou renvoyant des tableaux vides (`files: [], patches: [], deleted_files: []`).
2. **Détection brownfield restrictive et inflation du prompt** : la fonction `checkIsBrownfieldSubpackageRepo` n'activait les instructions d'outils et de patchs que si la racine ne contenait aucun `package.json` et que les chemins commençaient par `backend/` ou `frontend/`. En outre, chaque fichier lu via `read_repo_file` restait dans `accumulatedFiles` et l'orchestrateur réinjectait toute cette table en texte brut dans les prompts de remédiation suivants.
3. **Absence de décomposition automatique sur troncature** : lorsqu'un appel d'implémentation échouait avec `StructuredOutputValidationError` malgré les relances de validation, l'orchestrateur suspendait immédiatement le ticket au lieu de segmenter la génération fichier par fichier selon `filesToTouch`.

## Décisions

### 1. Tampon de mutation incrémentale de ticket (`StagedTicketImplementationBuffer`)

- Pendant la phase 1 (boucle d'appels d'outils, plafonnée à `maxToolRounds = 35`) des appels d'implémentation et de remédiation d'un **Ticket d'implémentation**, `buildRepoExplorationToolsAndHandlers` expose trois outils d'écriture transactionnels lorsque `stagedImplementation` est fourni :
  1. `write_repo_file({ path, content })` : écrit ou remplace intégralement un fichier dans le **Tampon de mutation incrémentale de ticket**.
  2. `patch_repo_file({ path, edits })` : applique une liste de remplacements `old_string -> new_string` sur la version courante du fichier (issue du tampon, de `accumulatedFiles` ou de la **Branche de fonctionnalité**) et renvoie immédiatement `{ applied: true, path, total_lines }` ou une erreur explicite si une cible `old_string` est introuvable.
  3. `delete_repo_file({ path })` : marque un fichier existant comme supprimé dans le tampon.
- QUAND le modèle appelle `write_repo_file`, `patch_repo_file` ou `delete_repo_file`, ALORS le gestionnaire d'outil vérifie immédiatement que `path` ne contient aucune traversée `..` et ne cible aucun chemin sensible (`isSensitiveTaskBranchPath`), déclenche la capture de l'état initial du fichier sur la **Branche de fonctionnalité** (`ensureBaselineLoaded`), et enregistre la mutation uniquement dans le **Tampon de mutation incrémentale de ticket** sans modifier `accumulatedFiles` ni `featureChangedFilesMap`.
- QUAND le modèle appelle un outil de lecture (`read_repo_file`, `search_in_repo_file`, `search_repo_code`, `list_repo_files`) au cours du même tour, ALORS le gestionnaire d'outil lit en priorité l'état du **Tampon de mutation incrémentale de ticket**.
- QUAND le **Tampon de mutation incrémentale de ticket** contient au moins une mutation valide à l'entrée de la phase 2, ALORS le validateur `createGeneratedTicketImplementationSchema` accepte un objet JSON final comportant `files: []`, `patches: []` et `deleted_files: []` (seuls `commit_message` et `test_summary` restent requis), puis l'orchestrateur fusionne le tampon avec toute mutation complémentaire présente dans le JSON final.
- Les sessions de **Revue indépendante** (`runMultiAgentPrReviewPass`), d'**Audit de convergence de fonctionnalité zéro-contexte** (`runEpicConvergenceAudit`) et de planification (`grill-and-plan`) n'activent jamais `stagedImplementation` et demeurent strictement en lecture seule.

### 2. Repli segmenté fichier par fichier (`ChunkedTicketImplementationFallback`)

- QUAND l'appel principal d'implémentation ou de remédiation d'un ticket lève `StructuredOutputValidationError` (sortie tronquée ou absence de fichier modifié), ALORS l'orchestrateur conserve les mutations déjà enregistrées dans le **Tampon de mutation incrémentale de ticket** et déclenche le **Repli segmenté fichier par fichier** (`generateTicketImplementationWithFallback`).
- L'orchestrateur détermine la liste ordonnée des cibles restantes à partir de `ticket.filesToTouch` non encore modifiées dans le tampon (complétée par un lot de test unitaire dédié si aucun fichier de test n'a encore été produit), puis exécute un sous-appel LLM structuré par cible en partageant le même **Tampon de mutation incrémentale de ticket**.
- SI un sous-appel du **Repli segmenté fichier par fichier** échoue encore après ses relances de validation de schéma, ALORS l'orchestrateur abandonne l'intégralité du **Tampon de mutation incrémentale de ticket** sans modifier `accumulatedFiles` ni créer de commit partiel sur la **Branche de ticket**, et déclenche une **Escalade humaine** (`needs-human`) avec la raison `llm_request_invalid`.
- QUAND l'appel principal ou le **Repli segmenté fichier par fichier** aboutit, ALORS l'orchestrateur soumet l'ensemble consolidé des mutations à `validateWorkspaceFileOperations`, `validateTicketIntegrityGuard` et à la **Vérification locale de pré-publication (Stage 1)** avant tout commit sur `task/*`.

### 3. Détection brownfield unifiée et Catalogue compact de contexte de dépôt (`CompactWorkspaceFilesContext`)

- La fonction `checkIsExistingRepoWorkspace` active le mode brownfield (instructions d'exploration et de patchs) dès que le dépôt comporte au moins un fichier sur la branche de base ou dans l'espace de travail (`devBranchPaths.length > 0 || accumulatedFiles.size > 0`), indépendamment de la présence d'un `package.json` à la racine ou du nom des sous-répertoires.
- La fonction `buildCompactWorkspaceFilesContext` construit le **Catalogue compact de contexte de dépôt** sans jamais tronquer un fichier en son milieu :
  - L'orchestrateur injecte le contenu intégral des fichiers déjà modifiés par le ticket (`ticketChangedFilesMap`) ou explicitement ciblés par `ticket.filesToTouch` tant que chaque fichier compte au plus `400` lignes et que le volume cumulé ne dépasse pas `60 000` caractères.
  - L'orchestrateur liste tous les autres fichiers présents dans `accumulatedFiles` (ainsi que les fichiers cibles de plus de `400` lignes) sous la forme d'un index `chemin (N lignes)` invitant le modèle à les inspecter via `read_repo_file` ou `search_in_repo_file`.

## Conséquences

- Les **Tickets d'implémentation** volumineux écrivent leurs migrations, routes et suites de tests au fil de la boucle d'outils et ne saturent plus le tour final de **Sortie structurée par schéma**.
- En cas de troncature d'un appel mono-bloc, le **Repli segmenté fichier par fichier** complète automatiquement les fichiers manquants de `filesToTouch` tout en garantissant la transactionnalité en mémoire et le passage par `validateTicketIntegrityGuard` et Stage 1 avant tout commit Git.
- Les prompts de remédiation restent compacts grâce au **Catalogue compact de contexte de dépôt** tout en respectant l'interdiction absolue de tronquer le contenu d'un fichier transmis au modèle.
