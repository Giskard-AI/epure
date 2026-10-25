# Référence de Configuration (`.github/agents.yml`)

EPURE centralise l'ensemble des paramètres d'orchestration, du modèle LLM, de la gouvernance de revue et de la porte UI dans un unique fichier déclaratif versionné à la racine du dépôt : **`.github/agents.yml`**.

---

## Exemple Canonique Complet

Voici un fichier `.github/agents.yml` complet avec toutes les clés prises en charge et leurs valeurs par défaut (Q78, Q91–Q96) :

```yaml
# .github/agents.yml — Configuration Déclarative EPURE
schema_version: 1

epure:
  # SHA immuable de 40 caractères de Giskard-AI/epure
  pinned_sha: "7f9f5aafa90acb68c5374cf00833881c0467cf67"

branches:
  # Branche d'intégration active (définie comme branche par défaut du dépôt)
  default_integration: "dev"
  # Branche de release immuable (mise à jour par fast-forward exclusif depuis dev)
  release: "main"

llm:
  provider: "google-gemini"
  # Modèle principal de raisonnement, TDD et revue
  model: "gemini-3.8-flash"
  thinking_level: "HIGH"
  # Modèle à température nulle pour la synthèse du message de squash sémantique
  squash_summary_model: "gemini-3.8-flash"
  squash_summary_temperature: 0.0

orchestration:
  # Préfixe des références Git atomiques hors-branches (CAS)
  state_ref_prefix: "refs/epure/state/"
  # Nombre maximal de tours d'auto-remédiation par ticket avant escalade needs-human
  max_code_fix_attempts: 3
  # Plafond de reviewers spécialisés/transverses sélectionnés par diff (hors spec-parity-reviewer)
  max_parallel_reviewers: 4
  # Exécution en sandbox sans secret (arrêt fail-closed si l'isolation échoue)
  secretless_sandbox: true

review_roster:
  # Charge toujours les prompts des reviewers depuis la branche de confiance (jamais depuis la PR)
  trusted_branch: "dev"
  directory: ".cursor/agents"
  # Reviewer systématiquement inclus sur chaque PR
  always_include:
    - "spec-parity-reviewer"
  # Spécialistes et agents transverses disponibles
  available:
    - "domain-backend-reviewer"
    - "frontend-reviewer"
    - "infra-reviewer"
    - "architecture-reviewer"
    - "security-reviewer"
    - "standards-reviewer"
    - "accessibility-reviewer"
    - "design-reviewer"
    - "user-advocate"

ui_governance:
  # Active automatiquement DESIGN.md, user-advocate et impeccable-gate dès qu'une surface UI est touchée
  impeccable_enabled: true
  design_system_path: "DESIGN.md"
  # Preview GitHub Pages statique sur consentement pour les branches /prototype (désactivée par défaut, Q70)
  enable_pages_preview: false
  preview_retention_days: 14

sensitive_paths:
  # Toute modification de ces chemins sur task/* bloque l'auto-merge sauf label approved-sensitive-change
  - ".github/workflows/**"
  - ".github/agents.yml"
  - ".cursor/agents/**"
  - "CODEOWNERS"
```

---

## Détail des Sections

### `branches`

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `default_integration` | `string` | `"dev"` | Branche par défaut du dépôt où atterrissent les PRs documentaires `plan/*` approuvées et les PRs applicatives `feature/*` mergées par un humain. |
| `release` | `string` | `"main"` | Branche de production immuable mise à jour exclusivement par `release-promote.yml` en fast-forward depuis `dev`. |

### `llm`

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `provider` | `string` | `"google-gemini"` | Fournisseur LLM géré par le sidecar proxy local au runner. |
| `model` | `string` | `"gemini-3.8-flash"` | Modèle utilisé pour le Grill, la rédaction des specs, la boucle TDD et la revue multi-agents. |
| `thinking_level` | `"LOW" \| "MEDIUM" \| "HIGH"` | `"HIGH"` | Niveau de réflexion transmis à `thinkingConfig` de Gemini. |
| `squash_summary_temperature` | `number` | `0.0` | Température déterministe utilisée pour synthétiser le titre et le corps Conventional Commit avant chaque squash-merge (Q94). |

### `orchestration`

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `state_ref_prefix` | `string` | `"refs/epure/state/"` | Espace de noms des références Git utilisé pour la persistance d'état Compare-And-Swap (Q76). |
| `max_code_fix_attempts` | `integer` | `3` | Nombre maximal de tours de correction automatique sur une PR `task/*` ou `feature/*` avant l'ajout du label `needs-human` (Q78). |
| `max_parallel_reviewers` | `integer` | `4` | Plafond de reviewers métier/transverses sélectionnés par diff pour maîtriser la latence et la pertinence (Q92). |
| `secretless_sandbox` | `boolean` | `true` | Purge `LLM_API_KEY` et les clés privées PEM des GitHub Apps de tous les sous-processus de test/build ; échoue en mode *fail-closed* si l'isolation est impossible (Q74). |

### `ui_governance`

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `impeccable_enabled` | `boolean` | `true` | Active la génération de `DESIGN.md`, l'agent `user-advocate` (`design-gate` et `implementation-review`) et le check CI bloquant `impeccable-gate` dès que des fichiers UI sont modifiés (Q79, Q96). |
| `enable_pages_preview` | `boolean` | `false` | Option sur consentement explicite pour publier des previews statiques `/prototype` sur un environnement GitHub Pages isolé (Q70, Q73). |
| `preview_retention_days` | `integer` | `14` | Durée de conservation en jours avant purge automatique des previews hébergées (Q71). |

### `sensitive_paths`

Toute modification de `.github/workflows/**`, `.github/agents.yml`, `.cursor/agents/**` ou `CODEOWNERS` sur une branche `task/*` déclenche une **Escalade sur Chemin Sensible** : EPURE refuse le merge autonome dans `feature/*` et pose le label `needs-human` tant qu'un mainteneur n'a pas explicitement accordé le label `approved-sensitive-change` (Q81, Q93).

---

## Politique Supply-Chain & Sécurité Renovate (`renovate.json`)

Chaque dépôt EPURE (ainsi que `Giskard-AI/epure` lui-même) embarque un fichier **`renovate.json`** durci généré par `/setup-repo` (Q46–Q48) :

- **Quarantaine Anti-Jour-1 (`minimumReleaseAge`)** : Applique un délai minimal de `3 days` par défaut (`7 days` pour les mises à jour mineures et les GitHub Actions / images Docker, `14 days` pour les mises à jour majeures npm) associé à `internalChecksFilter: "strict"` et `prCreation: "not-pending"`. Aucune version fraîchement publiée ou compromise le jour 1 ne déclenche de PR avant la fin de la quarantaine.
- **Automatisation Maximale maîtrisée** : Regroupe les mises à jour `minor`, `patch`, `pin` et `digest` dans des PRs hebdomadaires consolidées (`npm-minor-and-patch`, `github-actions`, `docker`), épingle toutes les versions (`rangeStrategy: "pin"`, `helpers:pinGitHubActionDigests`, `docker:pinDigests`), assure la maintenance mensuelle du lockfile (`lockFileMaintenance`) et rebase automatiquement sur `dev` (`rebaseWhen: "behind-base-branch"`).
- **Isolation des Scripts Post-Install** : Force `npmrc: "ignore-scripts=true"` lors de la résolution Renovate afin d'empêcher l'exécution de scripts post-install arbitraires.
- **Aucun Auto-Merge Aveugle vers `dev`** : `automerge: false` et `platformAutomerge: false` sont verrouillés ; toutes les PRs Renovate ciblent `dev`, passent par la CI et le panel de review multi-agents, et peuvent déclencher l'agent de migration assistée (`auto_migrate`) uniquement si la provenance cryptographique de la GitHub App Renovate est vérifiée.
