# Référence des Commandes (`/epure`, Skill `/setup-repo` & CLI)

EPURE s'utilise à travers deux surfaces complémentaires :
1. **Le skill d'agent local `/setup-repo`** (`.agents/skills/setup-repo/SKILL.md` — **méthode privilégiée** pour initialiser ou reconfigurer un dépôt, ses Rulesets et son roster dynamique `.cursor/agents/*.md`).
2. **Les commandes slash sur les Issues GitHub (`/epure ...`)** pour piloter le cycle de vie d'une fonctionnalité au quotidien depuis l'interface GitHub.

---

## 1. Commandes Slash sur les Issues GitHub (`/epure`)

Toutes les commandes `/epure` se postent sous forme de commentaires sur une Issue GitHub. Chaque commande est protégée par une **Porte de Permissions Fail-Closed** : l'auteur du commentaire doit détenir la permission `write` ou `admin` sur le dépôt.

| Commande | Catégorie (Q101) | Phase Cible | Description |
| --- | --- | --- | --- |
| `/epure plan` | <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 1</span> | `grilling` | Initialise `refs/epure/state/<issue>`, inspecte le dépôt et démarre l'entretien d'architecture structuré (Grill). |
| *(Tout commentaire humain pendant le Grill)* | <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 1</span> | `grilling -> awaiting_approval` | Continuité implicite du Grill (Q84) : traite les réponses humaines en lot via le curseur `last_processed_comment_id`. Dès que toutes les ambiguïtés sont levées, génère automatiquement les artefacts sur `plan/*` et le DAG de tickets. |
| `/epure approve` | <span class="epure-badge epure-badge--human">Jalon Humain Obligatoire 2</span> | `implementation` | Fusionne en squash la PR documentaire `plan/* -> dev`, scelle le mandat signé `spec_sha` dans `refs/epure/state/<issue>`, ouvre `feature/<issue>-<slug>` et exécute le DAG de tickets (`task/* -> feature/*`). Permet aussi la **reprise idempotente** après un échec. |
| `/epure to-spec` | <span class="epure-badge epure-badge--optional">Commande Facultative</span> | `spec` | Force le passage immédiat du Grill à la génération de `GLOSSARY.md`, des ADRs, de `DESIGN.md` et de `docs/specs/<slug>.md` sur `plan/*`. |
| `/epure to-tickets` | <span class="epure-badge epure-badge--optional">Commande Facultative</span> | `tickets` | Force le découpage immédiat de la spécification présente sur `plan/*` en un graphe orienté acyclique (DAG) d'issues GitHub (`blocked_by`). |
| `/epure status` | <span class="epure-badge epure-badge--optional">Commande Facultative</span> | *(Lecture seule)* | Lit `refs/epure/state/<issue>` et publie un rapport à jour de la phase courante, du `spec_sha` verrouillé et de l'état de chaque ticket sans modifier le code. |
| `/epure cancel` | <span class="epure-badge epure-badge--optional">Commande Facultative</span> | `cancelled` | Marque le mandat comme `cancelled` dans `refs/epure/state/<issue>`, bloque toute nouvelle exécution de ticket et conserve les branches et traces d'audit existantes. |

> **Aide-mémoire contextuel repliable (`<details>`)** : Chaque commentaire d'issue, corps de sous-issue de ticket et description de Pull Request publié par EPURE intègre automatiquement en pied de message un bloc repliable `<details>` (`⌨️ Commandes /epure disponibles`) récapitulant les commandes disponibles et mettant en évidence la prochaine action recommandée selon la phase courante (`grilling`, `tickets`, `implementation`, `suspended`, `cancelled` ou `completed`).

---

## 2. Skill d'Agent de Bootstrap (`/setup-repo` — Recommandé)

Le skill **`.agents/skills/setup-repo/SKILL.md`** est la **façon privilégiée** d'initialiser ou de mettre à jour un dépôt consommateur EPURE depuis Cursor, Claude Code, Pi ou Codex :

```text
/setup-repo <owner>/<repo>
```

### Ce que fait le skill `/setup-repo`

1. **Analyse du projet** : inspecte la stack (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`), la structure des modules `src/` et la présence ou non d'une interface utilisateur.
2. **Simulation (`--dry-run`)** : exécute `dist/cli/setup-repo.mjs --dry-run` et présente le plan complet au mainteneur avant toute écriture.
3. **Conception dynamique du roster `.cursor/agents/*.md`** : crée, conçoit et adapte les reviewers spécialisés en fonction des composants réels du projet (socle transverse `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `user-advocate` + spécialistes métier/UI sur mesure avec routage `paths:`).
4. **Application idempotente (`--apply --apply-github-settings`)** : écrit `.github/agents.yml`, les workflows appelants épinglés par SHA, configure le dépôt en squash-only et installe les 3 Repository Rulesets.

---

## 3. CLI Sous-Jacente de Bootstrap (`dist/cli/setup-repo.mjs`)

Invoquée automatiquement par le skill `/setup-repo` (ou exécutable manuellement en ligne de commande) :

```bash
node dist/cli/setup-repo.mjs \
  --repo <owner>/<name> \
  --target-dir <chemin> \
  [--dry-run | --apply] \
  [--apply-github-settings] \
  [--no-frontend-reviewers] \
  [--domain-reviewers <slug1,slug2>] \
  [--agent-app-id <id>] \
  [--release-app-id <id>] \
  [--require-pr-approvals <N>]
```

| Option | Valeur par défaut | Description |
| --- | --- | --- |
| `--repo <owner/name>` | *(Obligatoire)* | Identifiant du dépôt GitHub cible (ex. `my-org/craft-calculator`). |
| `--target-dir <chemin>` | Répertoire courant | Chemin local où sont écrits `.github/agents.yml`, les workflows et `.cursor/agents/*.md`. |
| `--dry-run` | `true` (si `--apply` omis) | Affiche le plan complet de bootstrap sans modifier aucun fichier ni appeler d'API d'écriture. |
| `--apply` | `false` | Écrit les fichiers de configuration, les workflows appelants et le socle `.cursor/agents/*.md`. |
| `--apply-github-settings` | `false` | Applique le mode squash-only et les 3 Repository Rulesets via l'API REST GitHub. |
| `--no-frontend-reviewers` | `false` | Omet `frontend-reviewer`, `accessibility-reviewer` et `design-reviewer` pour les dépôts sans UI. |
| `--domain-reviewers <csv>` | Aucun | Génère des fichiers `.cursor/agents/<slug>-reviewer.md` supplémentaires pour les sous-domaines métier. |
| `--agent-app-id <id>` | Optionnel | ID numérique de `<owner>-epure-agent` ajouté en Bypass Actor PR sur `epure-feature-governance` (`feature/*`). |
| `--release-app-id <id>` | Optionnel | ID numérique de `<owner>-epure-release` ajouté comme unique Bypass Actor sur `epure-release-immutability` (`main` et `v*`). |
| `--require-pr-approvals <N>` | `0` | Nombre d'approbations humaines requises sur `dev` (`0` pour compatibilité mainteneur solo ; `>=1` en équipe). |

---

## 4. Assistant Interactif GitHub Apps (`setup-github-apps-wizard.sh`)

```bash
bash scripts/wizards/setup-github-apps-wizard.sh --repo <owner>/<name>
```

Accompagne pas à pas un mainteneur humain dans la création des deux GitHub Apps (`<owner>-epure-agent` et `<owner>-epure-release`) via le flux GitHub App Manifest et configure automatiquement les 5 secrets du dépôt (`LLM_API_KEY`, `EPURE_AGENT_APP_ID`, `EPURE_AGENT_APP_PRIVATE_KEY`, `EPURE_RELEASE_APP_ID`, `EPURE_RELEASE_APP_PRIVATE_KEY`).
