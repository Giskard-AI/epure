---
status: accepted
---
# Bootstrap local, séparation des GitHub Apps et configuration des dépôts consommateurs

## Contexte

`dev-automation` distribue à des tiers des Reusable Workflows et Custom Actions publics, exécutés sur les runners des dépôts consommateurs (ADR-0008). Chaque consommateur possède ses propres GitHub Apps (ADR-0009). Pour que l’adoption soit pratique, un skill doit configurer le dépôt et ses politiques sans dépendre d’un système déjà installé.

## Décisions — Q25 à Q28

1. **Deux GitHub Apps distinctes par utilisateur/organisation** :
   - **Agent App** : opérations nécessaires aux issues, branches, commits et PR, avec tokens d'installation temporaires de portée minimale ;
   - **Release App** : fast-forward contrôlé `dev` → `main`, tags et GitHub Releases ; ses credentials restent inaccessibles aux agents de développement.
2. **Skill `setup-repo` complet, rejouable** : configure ou propose les workflows d'appel, Custom Actions, configuration agent, GitHub Apps/permissions et secrets, branch protections/rulesets, Renovate, zizmor et limites techniques d’exécution (tentatives, concurrence, timeouts). Les contrôles financiers sont configurés, si disponibles, directement chez le fournisseur LLM (ADR-0012). Le skill inspecte l'existant, fournit un mode `--dry-run`, vérifie les prérequis et n’écrase pas aveuglément des configurations installées.
3. **Bootstrap local** : skill lancé avec Pi, Codex ou agent local, en utilisant notamment `gh`. Il fonctionne sans secrets CI ni workflows installés. Les créations d’Apps, consentements, changements de protections, saisies/transferts de secrets et autres actes sensibles nécessitent une intervention/confirmation humaine. Ne pas exposer de clés privées au modèle ni dans les issues/logs.
4. **Configuration par dépôt** : `.github/agents.yml` versionné dans le dépôt consommateur, complété par des valeurs par défaut sûres de `dev-automation`. Les secrets et variables peuvent être hébergés à l'échelle de l'organisation selon les droits GitHub, mais un dépôt ne peut pas réduire les contrôles de sécurité imposés par les workflows partagés.

## Conséquences

- Installation automatisée autant que possible, mais pas nécessairement totalement sans interaction compte tenu des permissions GitHub.
- Le skill doit être testé contre les déploiements neufs, partiels et déjà configurés, y compris sa réexécution.
- L'App de release et l'App des agents constituent deux domaines de confiance différents. Il faut des secrets, conditions et politiques de branche adaptés, pas simplement deux noms d'Apps.
- La configuration locale doit être validée selon un schéma versionné avant l'exécution et filtrée contre les limites imposées par le workflow.

## À clarifier

- Mécanisme précis de provisionnement/rotation des credentials locaux et d'organisation.
- Versionnement de l'interface de configuration et de `setup-repo`.
- Cas des forks, dépôts privés et organisations imposant des politiques Actions particulières.
