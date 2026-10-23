---
status: accepted
---
# Distribution immuable, isolation des commandes et protection des branches

## Contexte

`dev-automation` expose des Reusable Workflows et des Custom Actions publics (ADR-0008), exécutés chez les consommateurs. Il faut maîtriser leur version, empêcher l'accès aux secrets par du code non fiable et encadrer l'intégration automatique de tickets (ADR-0001 et ADR-0004).

## Décisions acceptées

1. **Q29 — Distribution** : référencer chaque workflow/action externe par un **SHA complet** ; publier des releases SemVer ; Renovate propose les mises à jour via PR. Les tags sont des repères de version, pas des garanties d'immuabilité.
2. **Q31 — Isolation** : exécuter les tests, scripts applicatifs et outils susceptibles d'être influencés par du code non fiable dans un sandbox sans accès aux clés LLM, tokens GitHub en écriture ni autres secrets. Une action composite ne constitue pas une isolation ; la frontière dépend des jobs et d'un confinement réel du processus.
3. **Q32 — Branches** : `task/* → feature/*` : CI + review IA obligatoires et possibilité de merge automatique hors changements sensibles ; `feature/* → dev` : review et validation humaine obligatoires ; `dev → main` : action de release à déclenchement humain, fast-forward strict. Les règles de protection, autorisations de bypass et checks nécessaires doivent être vérifiés par l'installateur.

## Q30 — Clarification finale

La proposition de comptabilité LLM dans GitHub a été refusée. La clarification ultérieure a établi que **toute gestion financière est externe, chez le fournisseur LLM ou au niveau de la clé API**. Aucun budget monétaire interne par ticket ou fonctionnalité n'est maintenu. Les limites de tentatives, de concurrence et de durée restent valables. Voir [ADR-0012](0012-controle-operationnel-et-facturation-llm-externalisee.md).

## Conséquences

- Tests de contrat sur les pins et la mise à jour Renovate des références externes.
- Tests d'isolement incluant la tentative de lecture des secrets depuis des commandes non fiables.
- Contrôles des PR vérifiés sur le résultat intégré, pas sur une ancienne base.
- L'installation doit signaler les garanties de protections de branche indisponibles selon le plan ou les règles GitHub du dépôt.
