---
status: accepted
---
# GitHub App possédée par le consommateur et configuration guidée par skill

## Contexte

Les Reusable Workflows et les Custom Actions de `dev-automation` sont distribués publiquement et exécutés sur les runners des dépôts appelants (ADR-0008). L’outil doit fonctionner sans service central ni gestion des credentials des tiers par son mainteneur. Le bootstrap implique toutefois de créer une identité GitHub capable de commenter les issues, de publier des branches et d’ouvrir des PR.

## Décisions acceptées — Q24 et précision de l’utilisateur

1. Chaque utilisateur ou organisation consommatrice **enregistre et possède sa propre GitHub App**, installée sur les dépôts qu’elle autorise. Le mainteneur de `dev-automation` ne fournit ni App partagée ni serveur de jetons. Une même App peut être installée sur plusieurs dépôts choisis ; le nombre d’Apps selon les rôles de sécurité reste ouvert.
2. Les workflows consommateurs obtiennent leurs **installation access tokens temporaires** au moyen des credentials de l’App appartenant au consommateur, avec permissions réduites à l’opération. Les credentials persistants nécessaires sont gérés dans les secrets/variables du dépôt ou de l’organisation, jamais dans les tickets, les logs ou les prompts du LLM.
3. `dev-automation` distribue dès le départ un **skill de configuration d’un dépôt consommateur**, qui doit guider l’installation et les validations préalables. Les opérations privilégiées (création, installation d’App, saisie de clé privée, activation des protections) restent sous contrôle du propriétaire autorisé.
4. Le skill doit être **rejouable** : inspecter l’état existant et proposer seulement les changements nécessaires, sans réinitialiser aveuglément les secrets ni écraser la configuration du dépôt.

## Conséquences

- Installation un peu plus longue, mais pas d’infrastructure hébergée pour les tiers.
- Chaque consommateur contrôle ses clés, les dépôts autorisés et les permissions demandées.
- La GitHub App manifest flow de GitHub peut faciliter la création, mais sa mise en œuvre complète impose un flux de retour sécurisé ; elle n’est pas une hypothèse nécessaire pour la V1.
- Documentation et diagnostic du skill constituent une partie de l’expérience produit.

## Précisions validées en Q25–Q28

- Deux Apps distinctes (Agent App, Release App), détaillées dans [ADR-0010](0010-bootstrap-et-configuration-des-depots-consommateurs.md).
- Bootstrap local assisté par Pi/Codex et GitHub CLI, avant installation des workflows.
- Installation complète, rejouable avec dry-run, y compris Renovate, zizmor, protections et configuration LLM.
- Configuration locale par dépôt, sans possibilité de contourner les garde-fous de sécurité.

## À clarifier

- Support des dépôts privés et des organisations aux politiques GitHub Actions restrictives dès la V1.
- Procédure exacte de provisioning/retrait des secrets dans l’environnement local.
