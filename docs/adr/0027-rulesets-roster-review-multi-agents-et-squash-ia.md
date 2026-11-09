---
status: accepted
---
# Gouvernance par trois Rulesets, Roster de Review Multi-Agents de confiance et Squash Sémantique par IA

## Contexte

Le test pilote de bout en bout d'`EPURE v1.1.0` sur un dépôt consommateur réel (`my-org/craft-calculator`) et la comparaison avec une architecture de référence multi-agents ont mis en évidence quatre décisions structurantes difficiles à inverser :
1. Un GitHub Repository Ruleset unique ciblant simultanément `refs/heads/dev` et `refs/heads/feature/*` partagerait ses `bypass_actors` : accorder un bypass à l'`Agent App` pour squash-merger `task/* -> feature/*` lui permettrait aussi de fusionner du code applicatif dans `dev` sans intervention humaine, ce qui violerait la frontière de validation humaine ([ADR-0001](0001-branches-et-frontieres-de-validation.md), Q45).
2. Un dépôt consommateur héberge dans un répertoire de roster versionné (`reviewers_dir`, `.agents/reviewers/*.md` par défaut) les définitions de ses reviewers spécialisés, transverses et `user-advocate`, enrichies avec les personas et invariants du domaine lors de `/epure plan`. Charger ces prompts directement depuis la branche de travail `task/*` inspectée exposerait la review à une injection de prompt d'auto-approbation par l'exécuteur ([ADR-0004](0004-separation-execution-et-publication.md), [ADR-0017](0017-prevention-des-boucles-review-independante-et-reprises.md)).
3. La sélection et les re-passes de review multi-agents doivent concilier couverture spécialisée (domaine, UI, sécurité, parité spec, accessibilité Impeccable, personas `user-advocate`) et maîtrise du coût/temps sous le plafond `max_code_fix_attempts = 3` (Q78).
4. La politique squash-only exige des messages Conventional Commits fidèles au diff final sans se heurter au fait que GitHub n'interprète les mots-clés de fermeture (`Closes #N`) que lors d'un merge vers la branche par défaut (`dev`).

## Décisions (Ronde 22 & 23 — Q91 à Q96)

1. **Q91 & Q95 — Découpage en trois Repository Rulesets et ergonomie Solo-Maintainer** :
   - `setup-repo` configure le dépôt en **squash-only** (`allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`) et provisionne de manière idempotente **trois Rulesets distincts** :
     1. `epure-feature-governance` (`refs/heads/feature/*`) : interdit suppression et force-push, impose PR squash-only, statut checks (`verify-contract`, `PR title`, `ai-review`) et regex Conventional Commit (`^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\([a-z0-9/-]+\))?(!)?: .+`), avec l'`Agent App` en `bypass_actors` (`bypass_mode: "pull_request"`) pour le squash-merge autonome des PRs `task/* -> feature/*` une fois tous les checks requis au vert.
     2. `epure-dev-governance` (`refs/heads/dev`) : mêmes règles d'intégrité, de checks et de format de commit, avec `required_approving_review_count: 0` par défaut (configurable via `--require-pr-approvals <N>` pour les équipes) afin qu'un mainteneur solo puisse fusionner ses propres PRs ou celles du bot sans friction, tout en interdisant par garde-fou matériel dans le publisher tout auto-merge par l'`Agent App` sur `dev` en dehors de la PR documentaire `plan/* -> dev` consécutive à `/epure approve`.
     3. `epure-release-immutability` (`refs/heads/main`, `refs/tags/v*`) : immuabilité stricte avec la seule `Release App` en `bypass_actors` (Q80).

2. **Q92 — Source de confiance des prompts du roster (`reviewers_dir`) et chemin sensible** :
   - Le répertoire du roster est configurable via la clé `reviewers_dir` de `.github/agents.yml` (`.agents/reviewers` par défaut, agnostique de tout IDE) ou `setup-repo --reviewers-dir <chemin>` (p. ex. `.cursor/agents` pour une équipe souhaitant que Cursor charge les reviewers comme sous-agents). Un chemin absolu, comportant un segment `.` ou `..`, ou situé sous `src/` est rejeté en *fail-closed* avec `SECURITY_INVARIANT_VIOLATION`.
   - `setup-repo` initialise dans ce répertoire du dépôt consommateur le socle (`domain-backend-reviewer.md`, `frontend-reviewer.md`, `infra-reviewer.md`, `architecture-reviewer.md`, `security-reviewer.md`, `spec-parity-reviewer.md`, `standards-reviewer.md`, `accessibility-reviewer.md`, `design-reviewer.md`, `user-advocate.md`).
   - À la fin du Grill (`/epure plan`), l'orchestrateur adapte ces fichiers sur `plan/*` avec les personas et invariants du projet, qui sont ensuite intégrés dans `dev` après `/epure approve`.
   - Lors de l'évaluation d'une PR `task/* -> feature/*`, l'orchestrateur charge **exclusivement** `<reviewers_dir>/*.md` depuis la branche de base de confiance (`dev`), avec repli sur les templates embarqués dans `EPURE`, et jamais depuis la branche `task/*` inspectée.
   - Tout changement touchant le `reviewers_dir/**` configuré (ainsi que `.agents/reviewers/**` par défaut) sur une branche `task/*` est classé comme **chemin sensible** (au même titre que `.github/workflows/**` et `.github/agents.yml`, Q32) et interdit l'auto-merge sans validation humaine.

3. **Q93 & Q96 — Sélection plafonnée à 4 reviewers, re-review ciblée et double porte `user-advocate` + Impeccable** :
   - À la fin du Grill (`/epure plan`), si la fonctionnalité comporte une interface utilisateur, l'orchestrateur génère `DESIGN.md` (conventions Impeccable) et exécute `user-advocate` en mode **`design-gate`** pour enrichir les critères d'acceptation UX des tickets avant `/epure approve`.
   - Sur chaque PR `task/* -> feature/*`, `selectReviewersForDiff` sélectionne au maximum **4 reviewers** pertinents selon les chemins modifiés, les exécute en parallèle en lecture seule avec sortie JSON structurée (`must_fix`, `informational`, `no_action`), et évalue `impeccable-gate` + `user-advocate` (`implementation-review`) dès que des fichiers UI sont touchés.
   - Le budget `max_code_fix_attempts = 3` (Q78) est partagé entre corrections de tests sandbox et corrections de review (`must_fix > 0`) ; lors des tours 2 et 3, seuls les reviewers ayant émis un `must_fix` au tour précédent ainsi que `spec-parity-reviewer` sont ré-exécutés.
   - Une passe complète de synthèse (`architecture-reviewer`, `spec-parity-reviewer`, `user-advocate`, et `impeccable-gate` si UI) est également publiée sur la PR finale `feature/* -> dev` pour éclairer le validateur humain.

4. **Q94 — Synthèse IA du message de squash sémantique et convention `Refs` vs `Closes`** :
   - Juste avant chaque squash-merge, un appel LLM léger à température `0.0` (modèle `models.review` de `.github/agents.yml`) synthétise à partir du diff consolidé de la PR un `commit_title` Conventional Commit (`type(scope): summary (#PR)`) et un `commit_message` concis en liste à puces.
   - Le titre de la PR est synchronisé via `PATCH /repos/{owner}/{repo}/pulls/{pr_number}` avant le merge.
   - Les squash-merges `task/* -> feature/*` utilisent `Refs #<ticket>` (car `feature/*` n'est pas la branche par défaut) et l'orchestrateur clôt explicitement le ticket via l'API Issues, tandis que la PR finale `feature/* -> dev` inclut `Closes #<plan_issue>` et `Closes #<ticket>` pour déclencher la liaison et la fermeture natives de GitHub à l'atterrissage sur `dev`.

## Conséquences

- Séparation étanche des privilèges de merge entre `feature/*`, `dev` et `main`.
- Immunité de la chaîne de review face aux modifications du répertoire du roster (`reviewers_dir`) sur une branche de tâche.
- Roster indépendant de tout IDE par défaut, tout en restant chargeable par un IDE particulier via `--reviewers-dir`.
- Historique Git linéaire sur `feature/*` et `dev` composé uniquement de commits sémantiques résumant le diff réel.

## Amendement (v3.0.0, #108)

EPURE écrit directement sur `feature/*` (intégration du plan, synchronisation depuis `dev` par commit de merge, résolution de conflits à deux parents). Le bypass `pull_request` de la décision 1.1 rejetait ces écritures (`422 Changes must be made through a pull request`) et `required_linear_history` interdisait les commits de merge. `epure-feature-governance` donne donc à l'`Agent App` un bypass `always` et ne pose plus `required_linear_history` ; les humains restent soumis aux PRs. `dev` garde un historique linéaire.

Un bypass `always` couvrirait aussi la suppression et le force-push d'une branche `feature/*`. Ces deux règles passent dans un quatrième Ruleset, `epure-feature-integrity` (`deletion`, `non_fast_forward`), sans aucun Bypass Actor : ni l'`Agent App` ni un humain ne peut réécrire ou supprimer une branche de fonctionnalité. `epure-feature-governance` garde la PR, les checks et le motif de commit.

Conséquence opérationnelle, à reporter dans les notes de migration v3.0.0 : les branches `feature/*` fusionnées dans `dev` ne sont plus supprimées. `delete_branch_on_merge` ne les supprime pas et un administrateur reçoit lui aussi un refus. Le Ruleset n'est pas affaibli pour autant : pour élaguer, un administrateur désactive temporairement `epure-feature-integrity`, supprime les branches fusionnées, puis le réactive.

## Amendement (v3.0.0, #97) — Rulesets de release

La décision 1.3 plaçait `main` et `refs/tags/v*` dans un seul Ruleset. GitHub n'accepte qu'une cible par Ruleset (`branch` ou `tag`) et refuse ce Ruleset avec un `422`. La release est donc portée par deux Rulesets, avec la seule `Release App` en `bypass_actors` (`always`) :

1. `epure-release-tags` (cible `tag`, `refs/tags/v*`) : règles `creation`, `update` et `deletion`. Personne d'autre ne crée, ne déplace ni ne supprime un tag `v*`.
2. `epure-release-immutability` (cible `branch`, `refs/heads/main`) : règles `update`, `deletion`, `non_fast_forward` et `pull_request`. La règle `update` refuse aussi le merge d'une PR vers `main` : sans elle, tout acteur ayant l'accès en écriture, `Agent App` comprise, pouvait faire avancer `main` en fusionnant une PR. Seul l'unique `git push --atomic` de `release-promote.yml` (fast-forward de `main` et tag annoté) fait avancer `main`.

`setup-repo` applique `epure-release-tags` avant `epure-release-immutability` : une application interrompue ne laisse jamais les tags `v*` sans protection. `--apply-github-settings` et son dry-run s'arrêtent avant tout appel GitHub si l'ID d'une App déclarée en Bypass Actor manque (`--release-app-id`, `--agent-app-id`) : le Ruleset serait sinon installé sans Bypass Actor, ou perdrait celui déjà installé, et bloquerait l'App.

Conséquence opérationnelle : le hotfix manuel sur `main` prévu par l'[ADR-0005](0005-release-fast-forward-et-synchronisation-des-adr.md) exige qu'un administrateur désactive temporairement `epure-release-immutability`, puis le réactive.

## Amendement (v3.0.0, #123)

Les checks des décisions 1.1 et 1.2 n'étaient jamais envoyés à GitHub : une PR `feature/* -> dev` pouvait être fusionnée avec la CI en échec. `epure-feature-governance` et `epure-dev-governance` envoient désormais une règle `required_status_checks` avec les noms que les workflows générés publient réellement : `Verify EPURE Consumer Contract / Verify EPURE Consumer Contract` (nom du job appelant suivi du job du workflow réutilisable), `PR title`, `Quality (Format, Lint, Typecheck, Test & Build)` et `Zizmor`.

- Chaque check est rattaché à l'App GitHub Actions (`integration_id` 15368). Ce rattachement écarte un résultat homonyme publié par une autre App (le check run `PR title` toujours vert de l'`Agent App`) ou par un token personnel. Il ne protège pas du contenu de la PR : `pull_request` exécute les workflows du commit de merge de la PR, donc une PR qui modifie ou ajoute un workflow, ou qui modifie `package.json` ou la configuration des tests exécutés par `Quality`, peut faire passer ces checks elle-même. Pour couvrir ce cas, le dépôt consommateur peut placer `.github/workflows/**`, `package.json` et les configurations de test sous `CODEOWNERS` et exiger la revue des code owners dans un Ruleset distinct sur `dev` (`setup-repo` écrase les modifications d'`epure-dev-governance` quand il le met à jour), ou utiliser des required workflows d'organisation.
- Avec le `GITHUB_TOKEN` de repli (sans secrets de l'`Agent App`), EPURE publie au nom de GitHub Actions : il ne publie alors pas son check run `PR title`, qui satisferait la règle. Le job `orchestrate-command` ne demande plus que `checks: read`.
- La règle envoie `do_not_enforce_on_create: true` : une nouvelle branche `feature/*` part d'un commit de `dev` qui n'a jamais exécuté les checks des PRs, et GitHub refusait sa création à tout acteur sans bypass.
- Le nom du job `Verify EPURE Consumer Contract` du workflow réutilisable `epure-check.yml` fait partie du contrat public : le renommer bloque le `dev` de chaque dépôt consommateur jusqu'à ce qu'il relance `setup-repo`.
- `ai-review` n'est plus exigé. Seul EPURE le publie, sur ses propres PRs : une PR Renovate (qui cible `dev`) ou humaine l'attendrait indéfiniment, et `dev` n'a aucun Bypass Actor.
- `strict_required_status_checks_policy` reste à `false`. Mettre à jour la branche de tête d'une PR `feature/* -> dev` est un push sur `feature/*` qu'`epure-feature-governance` refuse aux humains ; une règle stricte bloquerait la PR à chaque avancée de `dev`. La CI `pull_request` s'exécute déjà sur le commit de merge avec `dev`.
- Sur `feature/*`, l'`Agent App` reste en bypass `always` : ses squash-merges `task/* -> feature/*` dépendent de la porte CI d'EPURE, pas du Ruleset.
