# 04: Initialiser et reconfigurer un dépôt avec setup-repo

**What to build:** Un mainteneur exécute localement le skill `setup-repo` (et sa CLI TypeScript) sur un dépôt cible, prévisualise les changements, puis obtient un dépôt prêt à accueillir les agents (incluant `.github/agents.yml` avec les valeurs par défaut Q78 et les GitHub Repository Rulesets Q80) sans doublons lors d’un second passage.

**Blocked by:** 03 — Installer deux GitHub Apps à rôles distincts

**Status:** ready-for-agent

- [ ] Le mode simulation présente les workflows, politiques, secrets attendus, Rulesets et protections sans rien modifier.
- [ ] L’application guidée installe le minimum fonctionnel et signale les interventions humaines nécessaires.
- [ ] La configuration locale (`.github/agents.yml`) choisit modèles, harness, concurrence et options (défauts : `max_code_fix_attempts: 3`, `max_transient_api_retries: 4`, `job_timeout_minutes: 60` implémentation / `30` review, `max_concurrent_tasks_per_feature: 3`, `trace_retention_days: 30`) tout en respectant des restrictions de sécurité non affaiblissables.
- [ ] Un second passage n’ajoute pas de ressource en double ; sans CI/protection minimale, l’auto-merge demeure désactivé.
- [ ] Des secrets/variables d’organisation peuvent être utilisés dans un second dépôt sans lui déléguer plus de permissions.

**Traçabilité :** user stories US-6, US-7, US-11, US-12, US-13 ; tests T-31 ; ADR-0010, ADR-0023, ADR-0025.
