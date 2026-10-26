---
status: accepted
---
# Vérification polyglotte en sandbox sur clone Git et boucle d'auto-réparation de CI externe multi-workflows

## Contexte

Un dépôt consommateur d'`EPURE` peut être un monorepo (`frontend/`, `backend/`, `packages/*`, `services/*`, `crates/*`), un projet Python (`pyproject.toml`, `pytest`, `ruff`, `mypy`), Go (`go.mod`), Rust (`Cargo.toml`), Node/TypeScript ou piloté par un orchestrateur (`Makefile`, `Justfile`, `Taskfile.yml`, `turbo.json`), et sa CI GitHub Actions peut être répartie sur plusieurs fichiers `.github/workflows/*.{yml,yaml}` comportant des conteneurs de service (PostgreSQL, Redis, Docker, Nginx). La vérification par l'agent ne peut donc ni supposer un unique `package.json` à la racine ni fusionner une PR avant la réussite des workflows CI externes du dépôt.

## Décisions (Q104 à Q111)

1. **Q104 — Autorité et configurabilité complète du profil de vérification (`.github/agents.yml` chargé depuis `dev`)** : le bloc `verification` (`wait_for_external_ci`, `external_ci_timeout_minutes`, `grace_window_seconds`, `targets[]` et l'ensemble de leurs commandes/patterns) est intégralement configurable par dépôt dans `.github/agents.yml` (en complément de `job_timeout_minutes` et `max_code_fix_attempts`), avec des valeurs par défaut sûres (`wait_for_external_ci: true`, `external_ci_timeout_minutes: 15`, `grace_window_seconds: 45`). Il est lu exclusivement depuis la branche de base de confiance (`dev`) — jamais depuis la branche non fiable `task/*` — et `.github/agents.yml` est classé comme chemin sensible déclenchant une escalade humaine en cas de modification sur `task/*`.
2. **Q105 — Séparation Stage 1 (sandbox locale sur clone Git) et Stage 3 (CI GitHub Actions externe)** :
   - **Stage 1 (Pré-publication en sandbox sans secret)** : l'orchestrateur prépare un clone Git peu profond (`--depth=1`) de la branche cible sur le runner, applique les créations/patchs/suppressions de fichiers et exécute uniquement sur les cibles impactées (`path_patterns`) les commandes `install_command`, `codegen_command` (ex: `prisma generate`), `typecheck_command`, `lint_command` et `test_command` unitaires/scripts ne requérant pas de conteneur externe.
   - **Stage 3 (Post-PR via les workflows GitHub Actions natifs du dépôt)** : les tests d'intégration avec services (`services:`, Docker Compose, builds multi-stage, smoke tests) sont délégués aux workflows GitHub Actions natifs du dépôt consommateur déclenchés par la PR.
3. **Q106 — Quota unifié de remédiation et diagnostic d'échec CI** : les erreurs de compilation/typage détectées en Stage 1 sont corrigées à l'intérieur du tour TDD avant publication de la PR. Après ouverture ou mise à jour de la PR, chaque ronde de validation attend conjointement la *Review IA multi-agents* (Stage 2) et la *CI externe* (Stage 3) et fusionne leurs constats dans une passe unique de correction (plafonnée à `max_code_fix_attempts = 3`). Un échec purement infrastructurel (timeout réseau de registre, préemption de runner) déclenche une relance du job sans consommer de tentative de modification de code.
4. **Q107 & Q108 — Découverte et attente multi-workflows agnostiques des noms de fichiers (`.github/workflows/*.{yml,yaml}`)** :
   - Lors de `setup-repo` et en repli runtime (si `verification.targets` est absent de `.github/agents.yml`), `detectRepositoryStack` inspecte conjointement les manifestes par dossier (`package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `go.work`), les orchestrateurs (`Makefile`, `Justfile`, `Taskfile.yml`, `turbo.json`) et **tous** les fichiers `.github/workflows/*.{yml,yaml}` (hors workflows `EPURE`) déclenchés sur `pull_request` ou `push`.
   - En Stage 3 (`waitForExternalCiChecks`), l'orchestrateur détermine dynamiquement les workflows externes attendus selon les fichiers modifiés et les filtres `on.pull_request.paths`/`branches`, observe une fenêtre d'amorçage (jusqu'à 45s) pour l'enregistrement des *check-runs* / *workflow_runs* sur le `head_sha`, puis attend leur complétude en mode *fail-closed*.
5. **Q109 — Extraction assainie et bornée des diagnostics CI (`~12 Ko`)** : lorsqu'un check externe échoue, l'orchestrateur combine les annotations GitHub Check (`GET /check-runs/{id}/annotations`) et un extrait filtré du log du job (`GET /actions/jobs/{job_id}/logs`, nettoyé des séquences ANSI/timestamps, centré sur les marqueurs `##[error]`, `FAIL`, `Error:`, `TS`, `Traceback`, `panicked at` et les 120 dernières lignes utiles, masqué des secrets et plafonné à ~12 Ko) qu'il injecte dans le prompt de correction avec le guide des commandes de vérification de la cible.
6. **Q110 — Réconciliation et auto-réparation idempotente des PRs ouvertes** : relancer `/epure approve` sur une issue dont une PR `task/* -> feature/*` ou `feature/* -> dev` est déjà ouverte inspecte directement les checks du `head_sha` courant et engage sans duplication la boucle de diagnostic et de réparation si un check externe ou la review IA est en échec.

## Conséquences

- Zéro faux positif de sandbox sur les monorepos ou dépôts non-Node : aucune PR ne peut être fusionnée vers `feature/*` ou finalisée vers `dev` avec une compilation ou un workflow CI externe en échec.
- Les dépôts existants n'ayant pas encore régénéré `.github/agents.yml` bénéficient automatiquement du repli de découverte polyglotte et multi-workflows au runtime.

## Références

Q9, Q31, Q50, Q74, Q78, Q91–Q94, Q104–Q111 ; ADR-0003, ADR-0010, ADR-0014, ADR-0016, ADR-0023, ADR-0026, ADR-0027.
