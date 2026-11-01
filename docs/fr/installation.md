# Installation & Bootstrap

La façon recommandée d'initialiser ou de reconfigurer un dépôt avec EPURE est d'invoquer le **skill d'agent `/setup-repo`** (`.agents/skills/setup-repo/SKILL.md`) directement depuis votre agent de développement compatible Skills.

Le skill `/setup-repo` orchestre l'ensemble du bootstrap de bout en bout : il analyse l'architecture réelle de votre dépôt, vous guide avec l'assistant interactif (`setup-github-apps-wizard.sh`) pour enregistrer vos deux GitHub Apps et vos environnements GitHub isolés (`<llm-env>` et `release`), exécute la CLI déterministe (`dist/cli/setup-repo.mjs`) en mode simulation (`--dry-run`) puis application (`--apply`), et **conçoit sur mesure votre roster de reviewers multi-agents (`reviewers_dir`, par défaut `.agents/reviewers/*.md`)**.

---

## Prérequis Système

Avant d'initialiser un dépôt avec EPURE, vérifiez que votre poste dispose de :

- **Un agent compatible Skills** (tout agent IDE ou CLI capable de charger le skill `.agents/skills/setup-repo/SKILL.md`)
- **Node.js 24 LTS** (`>=24.0.0`)
- **GitHub CLI (`gh`)** authentifiée sur votre compte ou organisation cible (`gh auth status`)
- **Git** (`>=2.38`)
- **Une clé API LLM** (`LLM_API_KEY` ou variable fournisseur configurée dans `.github/agents.yml`)

---

## Voie Recommandée : Bootstrapper via le Skill `/setup-repo`

Ouvrez votre dépôt cible dans votre agent et invoquez simplement le skill **`/setup-repo`** :

```text
/setup-repo my-org/craft-calculator
```

L'agent exécute alors un flux guidé en **4 étapes** avec confirmation humaine à chaque opération sensible :

### Étape 1 : Inspection de l'Architecture & des Sous-Domaines par l'Agent

Avant d'écrire le moindre fichier, l'agent inspecte le dépôt cible (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, arborescence `src/`, présence d'une interface utilisateur, `GLOSSARY.md` existant) afin de déterminer :

- La stack technique pour générer la CI (`.github/workflows/ci.yml`), `verification.targets`, `renovate.json`, `.github/zizmor.yml` et le reviewer de standards (`standards-reviewer.md`).
- La présence ou non d'une surface UI/Frontend (qui conditionne l'activation de la porte **Impeccable** et des reviewers `frontend-reviewer`, `accessibility-reviewer` et `design-reviewer`).
- Les sous-systèmes métier nécessitant la création de **reviewers spécialisés dédiés** dans `.agents/reviewers/<domaine>-reviewer.md` (ou votre `reviewers_dir` configuré).

### Étape 2 : Provisionnement des Deux GitHub Apps & des Secrets Cloisonnés par Environnement (Wizard)

Pour garantir une séparation stricte des privilèges (Q82, Q91) et zéro exposition de secrets aux workflows publics de Pull Request (conformité Zizmor), EPURE n'utilise jamais de jeton personnel (PAT) omnipotent ni de secrets globaux du dépôt. Chaque dépôt utilise **deux GitHub Apps distinctes** et **deux environnements GitHub isolés** (`<llm-env>` et `release`) :

1. **Agent App (`<owner>-epure-agent`)** : utilisée par l'orchestrateur pour l'automatisation quotidienne (`plan/*`, `task/*`, `feature/*`, Issues, PRs et Check Runs). Elle ne figure **jamais** parmi les Bypass Actors de `dev` ou `main`.
2. **Release App (`<owner>-epure-release`)** : utilisée exclusivement par `release-promote.yml` / `release.yml` lorsqu'un humain déclenche une promotion fast-forward de `dev` vers `main`. C'est le **seul Bypass Actor** autorisé sur `main` et les tags `v*`.

Lancez l'assistant interactif, qui propose l'**Approche 2** (flux local GitHub App Manifest en 1 clic) avec repli automatique sur l'**Approche 1** (enregistrement manuel guidé étape par étape) et injecte les secrets dans leurs environnements GitHub dédiés via `gh secret set --env` sans jamais exposer vos clés privées PEM au modèle LLM :

```bash
bash scripts/wizards/setup-github-apps-wizard.sh \
  --repo my-org/craft-calculator \
  --llm-env <llm-env>
```

> **Environnement `<llm-env>` libre et agnostique du LLM** : le nom de l'environnement d'agent (`<llm-env>`) vaut `epure-agent` par défaut et peut être choisi librement (autres exemples : `llm`, `openai`, `anthropic` ou `gemini` ; passez la même valeur à `setup-repo --llm-env`) et correspond au champ `environment: <llm-env>` du job `orchestrate-command` dans `.github/workflows/epure-issue-command.yml`.

| Nom du Secret | Environnement GitHub Cible | Rôle |
| --- | --- | --- |
| `LLM_API_KEY` | `--env <llm-env>` | Clé API utilisée uniquement par le client/proxy LLM (inaccessible à `authorize-command` et absente de la sandbox d'exécution du code). |
| `EPURE_AGENT_APP_ID` | `--env <llm-env>` | Identifiant numérique de l'application `<owner>-epure-agent`. |
| `EPURE_AGENT_APP_PRIVATE_KEY` | `--env <llm-env>` | Clé privée PEM de `<owner>-epure-agent` (sert à signer des jetons d'installation éphémères). |
| `EPURE_RELEASE_APP_ID` | `--env release` | Identifiant numérique de l'application `<owner>-epure-release` (associé à l'environnement protégé `release`). |
| `EPURE_RELEASE_APP_PRIVATE_KEY` | `--env release` | Clé privée PEM de `<owner>-epure-release` (utilisée uniquement par `release.yml` / `release-promote.yml`). |

Vérifiez le cloisonnement des secrets par environnement via `gh` :

```bash
gh secret list -R my-org/craft-calculator --env <llm-env>
gh secret list -R my-org/craft-calculator --env release
```

### Étape 3 : Simulation Non-Destructive (`--dry-run`)

Le skill `/setup-repo` invoque d'abord la CLI sous-jacente en mode `--dry-run` et vous présente le plan complet des fichiers, branches, labels et rulesets avant toute modification :

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /chemin/vers/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --dry-run
```

### Étape 4 : Application (`--apply`) & Conception sur Mesure du Roster de Reviewers

Après votre validation, le skill `/setup-repo` applique la gouvernance via `--apply --apply-github-settings`, puis rédige et adapte les prompts `.agents/reviewers/*.md` (ou ceux du répertoire choisi via `--reviewers-dir`) propres à votre dépôt :

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /chemin/vers/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --apply \
  --apply-github-settings
```

Commitez et poussez ensuite les fichiers générés (`.github/`, `.agents/reviewers/` et `renovate.json`) sur `dev` :

```bash
git add .github/ .agents/reviewers/ renovate.json
git commit -m "chore(epure): bootstrap repository governance and workflows"
git push origin dev
```

---

## Ce que Configure le Skill `/setup-repo`

1. **Topologie des Branches (`main` & `dev`)** :
   - Crée ou vérifie `main` (ligne de release immuable) et `dev` (branche d'intégration active).
   - Définit **`dev` comme branche par défaut** du dépôt afin que toutes les PRs ciblent `dev` et que les mots-clés `Closes #<issue>` ferment automatiquement les issues lors du merge sur `dev`.
2. **Labels Canoniques de Triage** :
   - Crée ou met à jour les 5 labels canoniques (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) ainsi que les labels d'orchestration (`needs-human`, `approved-sensitive-change`).
3. **Configuration Déclarative, Supply-Chain Durcie & Workflows Appelants** :
   - Génère `.github/agents.yml` (schéma canonique plat avec découverte automatique de `verification.targets`), `.github/zizmor.yml` (configuration d'analyse statique de sécurité des workflows) et `renovate.json` (avec quarantaines de 3 à 14 jours).
   - Installe `.github/workflows/epure-issue-command.yml`, `.github/workflows/epure-check.yml`, `.github/workflows/pr-title.yml`, `.github/workflows/ci.yml` (adapté à la stack détectée) et `.github/workflows/release.yml`, tous épinglés sur le SHA de 40 caractères d'EPURE (`Giskard-AI/epure`).
4. **Roster Dynamique de Reviewers Multi-Agents (`reviewers_dir`, par défaut `.agents/reviewers/*.md`)** :
   - L'agent qui exécute `/setup-repo` **crée, conçoit et ajoute au besoin les fichiers `<reviewers_dir>/<role>-reviewer.md`** en fonction des éléments réels du dépôt (et `/epure plan` les enrichit ensuite à chaque nouvelle fonctionnalité) :
     - **Socle transverse permanent** : `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer` (adapté au langage détecté : TypeScript, Python, Rust ou Go) et `user-advocate`.
     - **Spécialistes conçus sur mesure selon les éléments du projet** : `domain-backend-reviewer`, `infra-reviewer`, tout reviewer métier créé par l'agent pour vos sous-systèmes (ex. `realtime-reviewer.md`, `combat-engine-reviewer.md`, `sql-migration-reviewer.md` avec routage par `paths:` dans le frontmatter YAML), et — uniquement si le projet comporte une UI — les reviewers frontend/Impeccable (`frontend-reviewer`, `accessibility-reviewer`, `design-reviewer`).
     - *Exemple illustratif sur `craft-calculator` (application web TypeScript + React)* : l'agent assemble un roster de 10 reviewers combinant le socle transverse, `domain-backend-reviewer`, `infra-reviewer` et les 3 reviewers UI/Impeccable.
5. **Politique Squash-Only & 3 Repository Rulesets** :
   - Configure le dépôt en **Squash merge exclusif** (`allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`, `delete_branch_on_merge: true`).
   - Installe les 3 Rulesets GitHub :
     - `epure-feature-governance` (`refs/heads/feature/*`) : `Agent App` en bypass PR pour le squash-merge autonome des PRs `task/* -> feature/*`.
     - `epure-dev-governance` (`refs/heads/dev`) : aucun bypass pour l'`Agent App` (`required_approving_review_count: 0` par défaut pour permettre à un mainteneur solo de merger ses PRs ; configurable via `--require-pr-approvals <N>`).
     - `epure-release-immutability` (`refs/heads/main`, `refs/tags/v*`) : `Release App` comme unique Bypass Actor.
