---
status: accepted
---
# Gouvernance par trois Rulesets, Roster de Review Multi-Agents de confiance et Squash Sémantique par IA

## Contexte

Le test pilote de bout en bout d'`EPURE v1.1.0` sur un dépôt consommateur réel (`Hartorn-Inc/enclume-astrale`) et la comparaison avec l'architecture de référence `Hartorn-Inc/cozyvtt` ont mis en évidence quatre décisions structurantes difficiles à inverser :
1. Un GitHub Repository Ruleset unique ciblant simultanément `refs/heads/dev` et `refs/heads/feature/*` partagerait ses `bypass_actors` : accorder un bypass à l'`Agent App` pour squash-merger `task/* -> feature/*` lui permettrait aussi de fusionner du code applicatif dans `dev` sans intervention humaine, ce qui violerait la frontière de validation humaine ([ADR-0001](0001-branches-et-frontieres-de-validation.md), Q45).
2. Un dépôt consommateur héberge dans `.cursor/agents/*.md` les définitions de ses reviewers spécialisés, transverses et `user-advocate`, enrichies avec les personas et invariants du domaine lors de `/epure plan`. Charger ces prompts directement depuis la branche de travail `task/*` inspectée exposerait la review à une injection de prompt d'auto-approbation par l'exécuteur ([ADR-0004](0004-separation-execution-et-publication.md), [ADR-0017](0017-prevention-des-boucles-review-independante-et-reprises.md)).
3. La sélection et les re-passes de review multi-agents doivent concilier couverture spécialisée (domaine, UI, sécurité, parité spec, accessibilité Impeccable, personas `user-advocate`) et maîtrise du coût/temps sous le plafond `max_code_fix_attempts = 3` (Q78).
4. La politique squash-only exige des messages Conventional Commits fidèles au diff final sans se heurter au fait que GitHub n'interprète les mots-clés de fermeture (`Closes #N`) que lors d'un merge vers la branche par défaut (`dev`).

## Décisions (Ronde 22 & 23 — Q91 à Q96)

1. **Q91 & Q95 — Découpage en trois Repository Rulesets et ergonomie Solo-Maintainer** :
   - `setup-repo` configure le dépôt en **squash-only** (`allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`) et provisionne de manière idempotente **trois Rulesets distincts** :
     1. `epure-feature-governance` (`refs/heads/feature/*`) : interdit suppression et force-push, impose PR squash-only, statut checks (`verify-contract`, `PR title`, `ai-review`) et regex Conventional Commit (`^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\([a-z0-9/-]+\))?(!)?: .+`), avec l'`Agent App` en `bypass_actors` (`bypass_mode: "pull_request"`) pour le squash-merge autonome des PRs `task/* -> feature/*` une fois tous les checks requis au vert.
     2. `epure-dev-governance` (`refs/heads/dev`) : mêmes règles d'intégrité, de checks et de format de commit, avec `required_approving_review_count: 0` par défaut (configurable via `--require-pr-approvals <N>` pour les équipes) afin qu'un mainteneur solo puisse fusionner ses propres PRs ou celles du bot sans friction, tout en interdisant par garde-fou matériel dans le publisher tout auto-merge par l'`Agent App` sur `dev` en dehors de la PR documentaire `plan/* -> dev` consécutive à `/epure approve`.
     3. `epure-release-immutability` (`refs/heads/main`, `refs/tags/v*`) : immuabilité stricte avec la seule `Release App` en `bypass_actors` (Q80).

2. **Q92 — Source de confiance des prompts `.cursor/agents/*.md` et chemin sensible** :
   - `setup-repo` initialise dans le dépôt consommateur le socle `.cursor/agents/` (`domain-backend-reviewer.md`, `frontend-reviewer.md`, `infra-reviewer.md`, `architecture-reviewer.md`, `security-reviewer.md`, `spec-parity-reviewer.md`, `standards-reviewer.md`, `accessibility-reviewer.md`, `design-reviewer.md`, `user-advocate.md`).
   - À la fin du Grill (`/epure plan`), l'orchestrateur adapte ces fichiers sur `plan/*` avec les personas et invariants du projet, qui sont ensuite intégrés dans `dev` après `/epure approve`.
   - Lors de l'évaluation d'une PR `task/* -> feature/*`, l'orchestrateur charge **exclusivement** `.cursor/agents/*.md` depuis la branche de base de confiance (`dev`), avec repli sur les templates embarqués dans `EPURE`, et jamais depuis la branche `task/*` inspectée.
   - Tout changement touchant `.cursor/agents/**` sur une branche `task/*` est classé comme **chemin sensible** (au même titre que `.github/workflows/**`, Q32) et interdit l'auto-merge sans validation humaine.

3. **Q93 & Q96 — Sélection plafonnée à 4 reviewers, re-review ciblée et double porte `user-advocate` + Impeccable** :
   - À la fin du Grill (`/epure plan`), si la fonctionnalité comporte une interface utilisateur, l'orchestrateur génère `DESIGN.md` (conventions Impeccable) et exécute `user-advocate` en mode **`design-gate`** pour enrichir les critères d'acceptation UX des tickets avant `/epure approve`.
   - Sur chaque PR `task/* -> feature/*`, `selectReviewersForDiff` sélectionne au maximum **4 reviewers** pertinents selon les chemins modifiés, les exécute en parallèle en lecture seule avec sortie JSON structurée (`must_fix`, `informational`, `no_action`), et évalue `impeccable-gate` + `user-advocate` (`implementation-review`) dès que des fichiers UI sont touchés.
   - Le budget `max_code_fix_attempts = 3` (Q78) est partagé entre corrections de tests sandbox et corrections de review (`must_fix > 0`) ; lors des tours 2 et 3, seuls les reviewers ayant émis un `must_fix` au tour précédent ainsi que `spec-parity-reviewer` sont ré-exécutés.
   - Une passe complète de synthèse (`architecture-reviewer`, `spec-parity-reviewer`, `user-advocate`, et `impeccable-gate` si UI) est également publiée sur la PR finale `feature/* -> dev` pour éclairer le validateur humain.

4. **Q94 — Synthèse IA du message de squash sémantique et convention `Refs` vs `Closes`** :
   - Juste avant chaque squash-merge, un appel LLM léger à température `0.0` (`gemini-3.8-flash`) synthétise à partir du diff consolidé de la PR un `commit_title` Conventional Commit (`type(scope): summary (#PR)`) et un `commit_message` concis en liste à puces.
   - Le titre de la PR est synchronisé via `PATCH /repos/{owner}/{repo}/pulls/{pr_number}` avant le merge.
   - Les squash-merges `task/* -> feature/*` utilisent `Refs #<ticket>` (car `feature/*` n'est pas la branche par défaut) et l'orchestrateur clôt explicitement le ticket via l'API Issues, tandis que la PR finale `feature/* -> dev` inclut `Closes #<plan_issue>` et `Closes #<ticket>` pour déclencher la liaison et la fermeture natives de GitHub à l'atterrissage sur `dev`.

## Conséquences

- Séparation étanche des privilèges de merge entre `feature/*`, `dev` et `main`.
- Immunité de la chaîne de review face aux modifications de `.cursor/agents/*` sur une branche de tâche.
- Historique Git linéaire sur `feature/*` et `dev` composé uniquement de commits sémantiques résumant le diff réel.
