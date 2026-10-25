# Guide : Onboarder un Dépôt avec le Skill `/setup-repo`

Ce guide explique comment configurer un dépôt GitHub neuf ou existant (tel que `my-org/craft-calculator`) en invoquant **le skill d'agent `/setup-repo`** (`.agents/skills/setup-repo/SKILL.md`), qui est la façon privilégiée d'installer EPURE, ses 2 GitHub Apps, ses 5 secrets, `.github/agents.yml`, son roster dynamique `.cursor/agents/*.md` et ses 3 Repository Rulesets.

---

## 1. Créer les Deux GitHub Apps & les Secrets du Dépôt

EPURE sépare les privilèges d'orchestration quotidienne des privilèges de mise en production grâce à deux GitHub Apps :

- **`<owner>-epure-agent`** : permissions `contents: write`, `issues: write`, `pull_requests: write`, `checks: write`.
- **`<owner>-epure-release`** : permissions `contents: write`, `metadata: read`.

Exécutez l'assistant interactif (ou laissez le skill `/setup-repo` vous inviter à le lancer) :

```bash
bash scripts/wizards/setup-github-apps-wizard.sh --repo my-org/craft-calculator
```

Vérifiez que les 5 secrets sont bien enregistrés sur le dépôt cible :

```bash
gh secret list -R my-org/craft-calculator
```

Sortie attendue :

```text
EPURE_AGENT_APP_ID
EPURE_AGENT_APP_PRIVATE_KEY
EPURE_RELEASE_APP_ID
EPURE_RELEASE_APP_PRIVATE_KEY
LLM_API_KEY
```

---

## 2. Invoquer le Skill `/setup-repo` (Inspection & Simulation `--dry-run`)

Dans votre agent local (Cursor, Claude Code, Pi ou Codex), invoquez le skill **`/setup-repo`** sur le dépôt cible :

```text
/setup-repo my-org/craft-calculator
```

L'agent inspecte les éléments du dépôt (langage, scripts de build, présence d'une UI, sous-domaines dans `src/`) et lance d'abord la CLI en mode `--dry-run` :

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /chemin/vers/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --dry-run
```

Vérifiez que le rapport de simulation présenté par l'agent mentionne :

- La création de `.github/agents.yml` épinglé sur le SHA de 40 caractères de `Giskard-AI/epure`.
- La création de `.github/workflows/epure-issue-command.yml`, `epure-check.yml`, `pr-title.yml`, `ci.yml` et `release.yml`.
- L'initialisation dynamique du roster de reviewers `.cursor/agents/*.md` conçu par l'agent selon la stack et les sous-domaines du projet (socle transverse `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `user-advocate` + spécialistes métier/UI sur mesure, soit 10 agents dans l'exemple `craft-calculator`).
- La configuration des 3 Repository Rulesets (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`).

---

## 3. Confirmer l'Application (`--apply`) & Pousser sur `dev`

Après votre accord, le skill `/setup-repo` exécute `--apply --apply-github-settings`, ajuste les définitions `.cursor/agents/<role>-reviewer.md` propres à vos composants métier, et prépare les fichiers :

```bash
node dist/cli/setup-repo.mjs \
  --repo my-org/craft-calculator \
  --target-dir /chemin/vers/craft-calculator \
  --agent-app-id 123456 \
  --release-app-id 654321 \
  --apply \
  --apply-github-settings
```

Commitez et poussez ensuite les fichiers générés sur la branche par défaut `dev` :

```bash
cd /chemin/vers/craft-calculator
git checkout dev
git add .github/ .cursor/agents/
git commit -m "chore(epure): bootstrap repository governance and workflows"
git push origin dev
```

---

## 4. Mode Mainteneur Solo vs Mode Équipe (`--require-pr-approvals`)

- **Mainteneur Solo (Défaut `--require-pr-approvals 0`)** : GitHub interdit à l'auteur ou au seul mainteneur d'approuver une PR sans second compte. La valeur `required_approving_review_count: 0` sur `epure-dev-governance` vous permet de cliquer sur **Squash and merge** sur les PRs `feature/* -> dev` tout en interdisant matériellement à l'`Agent App` de les fusionner seule.
- **Mode Équipe (`--require-pr-approvals 1` ou plus)** : exige au moins une approbation humaine par un pair en plus des checks `verify-contract` et `ai-review` verts avant toute fusion dans `dev`.
