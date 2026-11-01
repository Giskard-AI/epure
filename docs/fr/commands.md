# Référence des Commandes (`/epure`, Skill `/setup-repo` & CLI)

EPURE s'utilise à travers deux surfaces complémentaires :
1. **Le skill d'agent local `/setup-repo`** (`.agents/skills/setup-repo/SKILL.md` — **méthode privilégiée** pour initialiser ou reconfigurer un dépôt, ses Rulesets et son roster dynamique de reviewers dans `reviewers_dir`, par défaut `.agents/reviewers/*.md`).
2. **Les commandes slash sur les Issues GitHub (`/epure ...`)** pour piloter le cycle de vie d'une fonctionnalité au quotidien depuis l'interface GitHub.

---

## 1. Commandes Slash sur les Issues GitHub (`/epure`)

Toutes les commandes `/epure` se postent sous forme de commentaires sur une Issue GitHub. Chaque commande est protégée par une **Porte de Permissions Fail-Closed** : l'auteur du commentaire doit détenir la permission `write` ou `admin` sur le dépôt.

| Commande | Catégorie (Q101) | Phase Cible | Description |
| --- | --- | --- | --- |
| `/epure plan` | <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 1</span> | `grilling` | Initialise `refs/epure/state/<issue>`, inspecte les fichiers du dépôt via les outils d'exploration (`list_repo_files`, `read_repo_file`, `search_in_repo_file`) et démarre l'entretien d'architecture structuré (Grill). |
| *(Tout commentaire humain pendant le Grill)* | <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 1</span> | `grilling` | Continuité implicite du Grill (Q84) : traite les réponses humaines via `last_processed_comment_id`. S'il reste des points ouverts (`frontier_resolved: false`), publie le round suivant. Dès que la frontière est résolue (`frontier_resolved: true`), publie une **Synthèse des Décisions** et attend la validation humaine (`/epure to-spec`) avant de générer la spec et les tickets. |
| `/epure to-spec` | <span class="epure-badge epure-badge--human">Validation Humaine de la Frontière</span> | `spec` | Valide la frontière de cadrage du Grill (ou force la fin du cadrage), exécute l'**Audit de Spécification Goldfish zéro-contexte** (`runGoldfishSpecAudit`), et génère `GLOSSARY.md`, les ADRs, `DESIGN.md` et `docs/specs/<slug>.md` (incluant `EpicGoalContract`) sur `plan/*`, puis passe en phase `spec` (`awaiting_human_approval`). Tout commentaire libre en phase `spec` révise la spécification sur `plan/*`. |
| `/epure to-tickets` | <span class="epure-badge epure-badge--human">Validation Humaine de la Spécification</span> | `tickets` | Valide la spécification sur `plan/*` et la découpe en un graphe orienté acyclique (DAG) de sous-issues GitHub (`blocked_by`, `ready-for-agent`), câble le graphe relationnel GitHub natif (`sub_issues` + `dependencies/blocked_by`) et passe en phase `tickets` (`awaiting_human_approval`) avant `/epure approve`. |
| `/epure approve` | <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 2</span> | `implementation` | Intègre directement les artefacts de `plan/*` (`GLOSSARY.md` en fusion additive, réconciliation monotone et sémantique des ADRs en collision, `docs/specs/<slug>.md`, `DESIGN.md`) dans `feature/<issue>-<slug>` sans PR intermédiaire `plan/* -> dev` (ADR-0031, ADR-0032), scelle le mandat signé `spec_sha` dans `refs/epure/state/<issue>` et exécute le DAG de tickets (`task/* -> feature/*`). |
| `/epure continue` | <span class="epure-badge epure-badge--optional">Reprise d'Exécution</span> | `implementation` | Reprend l'orchestration après la résolution d'une suspension `needs-human`, d'un conflit Git 3-way ou à l'issue de la CI externe (`waiting_ticket_ci` / `waiting_feature_ci`, ADR-0031). |
| `/epure sync` (alias `/epure rebase`) | <span class="epure-badge epure-badge--optional">Synchronisation Git</span> | `implementation` | Synchronise `dev -> feature/<issue>-<slug>` (et propage `feature/* -> active_task_branch`) avec fusion additive de `GLOSSARY.md`, réconciliation monotone des ADRs, résolution 3-way assistée par LLM et validation **Sandbox Stage 1** avant commit (ADR-0031, ADR-0032). |
| `/epure status` | <span class="epure-badge epure-badge--optional">Commande Facultative</span> | *(Lecture seule)* | Lit `refs/epure/state/<issue>` et publie un rapport à jour de la phase courante, du `spec_sha` verrouillé et de l'état de chaque ticket sans modifier le code. |
| `/epure cancel` (alias `/epure stop`) | <span class="epure-badge epure-badge--optional">Commande Facultative</span> | `cancelled` | Marque le mandat comme `cancelled` dans `refs/epure/state/<issue>`, bloque toute nouvelle exécution de ticket et conserve les branches et traces d'audit existantes. |

> **Aide-mémoire contextuel repliable (`<details>`)** : Chaque commentaire d'issue, corps de sous-issue de ticket et description de Pull Request publié par EPURE intègre automatiquement en pied de message un bloc repliable `<details>` (`⌨️ Commandes /epure disponibles`) récapitulant les commandes disponibles et mettant en évidence la prochaine action recommandée selon la phase courante (`grilling`, `spec`, `tickets`, `implementation`, `suspended`, `cancelled` ou `completed`).

---

## 2. Pipeline Événementiel GitHub Actions & Custom Actions (`epure-ci-actions-flow`)

<ArchifyDiagram
  slug="epure-ci-actions-flow"
  locale="fr"
  title="Pipeline Événementiel GitHub Actions, Custom Actions & CI d'EPURE"
  caption="Pipeline complet reliant issue_comment, la continuation CI check_suite/workflow_run, les portes de Pull Request et la promotion de release entre jobs sans secret et environnements cloisonnés."
/>

### Fonctionnement Détaillé du Pipeline `epure-issue-command.yml`

1. **Job 1 — Contrôle d'Autorisation Préalable Sans Secret (`authorize-command` via `actions/authorize-command`)** :
   - Déclenché sur `issue_comment.created` avec uniquement `GITHUB_TOKEN` (`contents: read`, `issues: write`) et **aucun secret d'agent ou de LLM**.
   - Vérifie que l'auteur du commentaire est un humain disposant de la permission effective `write` ou `admin` via `GET /repos/{owner}/{repo}/collaborators/{username}/permission`.
   - Grâce à `allow_implicit_planning_reply: "true"`, tout commentaire humain en texte libre (sans commande slash) posté pendant les phases `grilling` ou `spec` est automatiquement routé comme une commande `reply`.
2. **Job 2 — Orchestration Isolée sous Environnement d'Agent (`orchestrate-command` via `actions/orchestrate-issue`)** :
   - S'exécute sur `ubuntu-26.04` dans l'environnement GitHub dédié (`environment: <llm-env>`, `epure-agent` par défaut ; autres exemples : `llm`, `openai`, `anthropic` ou `gemini`) **uniquement après** validation par `authorize-command` (ou lors d'un événement de continuation CI autorisé).
   - Reçoit les secrets cloisonnés dans l'environnement (`EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY` et `LLM_API_KEY` ou clé fournisseur) et installe l'outillage de sandbox noyau (`bubblewrap`, `landrun`, `rtk`).
   - Lors de `/epure to-tickets`, crée les sous-issues GitHub et câble nativement le graphe relationnel GitHub (`sub_issues` parent-enfant + `dependencies/blocked_by`).
3. **Réveil Événementiel Automatique de la CI (`check_suite.completed` / `workflow_run.completed`)** :
   - Avec `async_ci_continuation: "true"`, dès l'ouverture d'une PR `task/* -> feature/*` (`waiting_ticket_ci`) ou `feature/* -> dev` (`waiting_feature_ci`), l'orchestrateur persiste la PR et le `head_sha` dans `refs/epure/state/<issue>` et termine immédiatement (`exit 0`) pour libérer le runner GitHub Actions.
   - Dès que la CI externe se termine sur `task/*` ou `feature/*`, l'événement `check_suite.completed` ou `workflow_run.completed` réveille `orchestrate-command` avec `command: "continue"`, `trigger_head_sha` et `trigger_branch` afin d'exécuter la revue multi-agents Stage 3, le squash sémantique IA ou un round d'auto-remédiation unifié.
4. **Portes de Contrat PR & Promotion de Release Protégée** :
   - Sur `pull_request` (`dev`, `main`, `feature/**`), `epure-check.yml` (`actions/epure-contract`), `pr-title.yml` et `ci.yml` s'exécutent en `contents: read` sans aucun secret privilégié.
   - Sur `workflow_dispatch` humain, `release.yml` s'exécute dans l'environnement protégé `environment: release` (`EPURE_RELEASE_APP_ID`, `EPURE_RELEASE_APP_PRIVATE_KEY`) via `actions/verify-app-role` pour promouvoir `dev -> main` en fast-forward.

---

## 3. Skill d'Agent de Bootstrap (`/setup-repo` — Recommandé)

Le skill **`.agents/skills/setup-repo/SKILL.md`** est la **façon privilégiée** d'initialiser ou de mettre à jour un dépôt consommateur EPURE depuis n'importe quel agent de développement compatible Skills :

```text
/setup-repo <owner>/<repo>
```

### Ce que fait le skill `/setup-repo`

1. **Analyse du projet** : inspecte la stack (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`), la structure des modules `src/` et la présence ou non d'une interface utilisateur.
2. **Simulation (`--dry-run`)** : exécute `dist/cli/setup-repo.mjs --dry-run` et présente le plan complet au mainteneur avant toute écriture.
3. **Conception dynamique du roster de reviewers (`reviewers_dir`, par défaut `.agents/reviewers/*.md`)** : crée, conçoit et adapte les reviewers spécialisés en fonction des composants réels du projet (socle transverse `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `user-advocate` + spécialistes métier/UI sur mesure avec routage `paths:`).
4. **Application idempotente (`--apply --apply-github-settings`)** : écrit `.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`, les workflows appelants épinglés par SHA, configure le dépôt en squash-only et installe les 3 Repository Rulesets.

---

## 4. CLI Sous-Jacente de Bootstrap (`dist/cli/setup-repo.mjs`)

Invoquée automatiquement par le skill `/setup-repo` (ou exécutable manuellement en ligne de commande) :

```bash
node dist/cli/setup-repo.mjs \
  --repo <owner>/<name> \
  --target-dir <chemin> \
  [--pinned-sha <sha-40-caracteres>] \
  [--dry-run | --apply] \
  [--apply-github-settings] \
  [--no-frontend-reviewers] \
  [--domain-reviewers <slug1,slug2>] \
  [--reviewers-dir <chemin>] \
  [--llm-env <nom-env>] \
  [--model <fournisseur/modèle>] \
  [--planning-model <fournisseur/modèle>] \
  [--implementation-model <fournisseur/modèle>] \
  [--review-model <fournisseur/modèle>] \
  [--agent-app-id <id>] \
  [--release-app-id <id>] \
  [--require-pr-approvals <N>] \
  [--json]
```

| Option | Valeur par défaut | Description |
| --- | --- | --- |
| `--repo <owner/name>` | *(Obligatoire)* | Identifiant du dépôt GitHub cible (ex. `my-org/craft-calculator`). |
| `--target-dir <chemin>` (alias `--dir`, `--repo-root`) | Répertoire courant | Chemin local où sont écrits `.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`, les workflows et les prompts des reviewers (`<reviewers_dir>/*.md`). |
| `--pinned-sha <sha>` | Dernier SHA EPURE | SHA Git immuable de 40 caractères de `Giskard-AI/epure` utilisé pour épingler les workflows appelants générés. |
| `--dry-run` | `true` (si `--apply` omis) | Affiche le plan complet de bootstrap sans modifier aucun fichier ni appeler d'API d'écriture. |
| `--apply` | `false` | Écrit les fichiers de configuration (`.github/agents.yml`, `.github/zizmor.yml`, `renovate.json`), les workflows appelants et le socle des prompts de reviewers (`<reviewers_dir>/*.md`, par défaut `.agents/reviewers/*.md`). |
| `--apply-github-settings` | `false` | Applique le mode squash-only et les 3 Repository Rulesets via l'API REST GitHub. |
| `--no-frontend-reviewers` | `false` | Omet `frontend-reviewer`, `accessibility-reviewer` et `design-reviewer` pour les dépôts sans UI. |
| `--domain-reviewers <csv>` | Aucun | Génère des fichiers `<reviewers_dir>/<slug>-reviewer.md` supplémentaires pour les sous-domaines métier. |
| `--reviewers-dir <chemin>` | `.agents/reviewers` | Répertoire du roster de reviewers écrit dans `.github/agents.yml` (`reviewers_dir`) et lu par l'orchestrateur depuis `dev` (p. ex. `--reviewers-dir .cursor/agents` pour une équipe souhaitant que Cursor charge les reviewers comme sous-agents). Les chemins absolus, les segments `.`/`..` et les chemins sous `src/` sont rejetés en *fail-closed* avec `SECURITY_INVARIANT_VIOLATION`. |
| `--llm-env <nom-env>` | `epure-agent` | Nom de l'environnement GitHub (`[A-Za-z0-9._-]`) écrit dans `.github/agents.yml` (`llm_environment`) et utilisé par le job `orchestrate-command` de `.github/workflows/epure-issue-command.yml`. Doit correspondre au `--llm-env` de l'assistant. |
| `--model <fournisseur/modèle>` | — | Définit en une fois `models.planning`, `models.implementation` et `models.review`. |
| `--planning-model <fournisseur/modèle>` | `anthropic/claude-sonnet-4-20250514` | Définit `models.planning`. |
| `--implementation-model <fournisseur/modèle>` | `anthropic/claude-sonnet-4-20250514` | Définit `models.implementation`. |
| `--review-model <fournisseur/modèle>` | `openai/gpt-4.1` | Définit `models.review`. |
| `--agent-app-id <id>` | Optionnel | ID numérique de `<owner>-epure-agent` ajouté en Bypass Actor PR sur `epure-feature-governance` (`feature/*`). |
| `--release-app-id <id>` | Optionnel | ID numérique de `<owner>-epure-release` ajouté comme unique Bypass Actor sur `epure-release-immutability` (`main` et `v*`). |
| `--require-pr-approvals <N>` | `0` | Nombre d'approbations humaines requises sur `dev` (`0` pour compatibilité mainteneur solo ; `>=1` en équipe). |
| `--json` | `false` | Affiche le résultat structuré complet `SetupRepoResult` au format JSON sur la sortie standard au lieu du résumé Markdown. |

---

## 5. Assistant Interactif GitHub Apps (`setup-github-apps-wizard.sh`)

```bash
bash scripts/wizards/setup-github-apps-wizard.sh \
  --repo <owner>/<name> \
  --llm-env <nom-env>
```

Accompagne pas à pas un mainteneur humain dans la création des deux GitHub Apps (`<owner>-epure-agent` et `<owner>-epure-release`) via l'**Approche 2** (flux local GitHub App Manifest en 1 clic) ou l'**Approche 1 de repli** (enregistrement manuel guidé étape par étape), crée les environnements GitHub isolés (`<llm-env>` — libre et agnostique du fournisseur LLM, `epure-agent` par défaut ; autres exemples : `llm`, `openai`, `anthropic`, `gemini` — ainsi que `release`), et configure les 5 secrets dans leurs environnements respectifs (`EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY` et `LLM_API_KEY` dans `--env <llm-env>` ; `EPURE_RELEASE_APP_ID` et `EPURE_RELEASE_APP_PRIVATE_KEY` dans `--env release`).
