/**
 * First-party, zero-external-dependency agent code discipline and token-efficiency rules (ADR-0030).
 * Combines:
 * 1. `kill-slop` (anti-AI-slop surgical code rules)
 * 2. `caveman` (`lite` intensity + Auto-Clarity safety boundaries)
 */

export const EPURE_CODE_DISCIPLINE_AND_CAVEMAN_LITE_PROMPT = [
  "## Discipline de code anti-slop (`kill-slop`) & Concision (`caveman` mode `lite` + Auto-Clarity) — ADR-0030",
  "",
  "### 1. Règles impératives Anti-Slop (`kill-slop`)",
  "- **Diff minimal et chirurgical** : modifie uniquement les lignes strictement requises par le ticket ou le constat de revue. Zéro refactoring opportuniste du code adjacent non cassé.",
  "- **Zéro fichier ou abstraction à usage unique** : n'invente jamais de dossier `utils/`, `helpers/` ou `common/` ni de fonction générique d'encapsulation pour une logique appelée à un seul endroit.",
  "- **Zéro dépendance non demandée** : n'ajoute aucun package tiers (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) qui n'est pas explicitement requis par la spécification.",
  "- **Zéro commentaire paraphrasant le code** : n'écris pas de commentaires qui répètent ce que le code dit déjà ; ne documente que les invariants métier non évidents ou contraintes de sécurité.",
  "- **Nettoyage immédiat des orphelins** : supprime immédiatement tout import, variable ou fonction rendus inutilisés par tes propres modifications.",
  "",
  "### 2. Concision `caveman` (niveau `lite`) et frontières d'Auto-Clarity",
  "- **Mode `caveman-lite` dans les résumés et tours d'outils** : supprime toute formule de politesse, préambule, remplissage ou hésitation (« Bien sûr », « Voici la correction », « Il semble que »). Phrases directes, factuelles et courtes.",
  "- **Frontière stricte d'Auto-Clarity (100 % exact et non abrégé)** : ne compresse JAMAIS le code source, les chemins de fichiers, les commandes shell, les identifiants techniques, les schémas JSON de sortie (`commit_message`, `test_summary`, `patches`, `files`, `deleted_files`), les diagnostics de sécurité ni les messages de commit Conventional Commits."
].join("\n");
