---
status: accepted
---
# État d'orchestration dans `refs/epure/state/*` et lecture en lot des commentaires

## Contexte

Dans GitHub Actions, un groupe `concurrency: issue-<N>` avec `cancel-in-progress: false` ne conserve qu'un seul run actif et au plus un run en attente : si un humain poste trois commentaires rapides pendant qu'un agent répond, l'événement intermédiaire est fusionné par GitHub Actions. De plus, stocker l'état machine d'orchestration (curseur de commentaire, mandat d'approbation JSON, compteurs d'essais) directement dans la branche `dev` polluerait l'historique applicatif et déclencherait inutilement la CI de `dev`.

## Décisions (Q75, Q76)

1. **Q75 — Sérialisation par issue et rattrapage en lot via curseur** : chaque workflow conversationnel ou d'orchestration d'issue utilise `concurrency: issue-<N>` sans annulation du run en cours. À son démarrage, le job lit l'ensemble des commentaires postés sur l'issue depuis `last_processed_comment_id` et les traite séquentiellement en lot avant de mettre à jour le curseur.
2. **Q76 — Stockage hybride hors branches applicatives (`refs/epure/state/<issue-number>`)** :
   - Les livrables documentaires métiers (`GLOSSARY.md`, `docs/adr/*.md`, `docs/specs/*.md`, `PRODUCT.md`, `DESIGN.md`) vivent sur `plan/<issue>` puis sont mergés dans `dev` à l'approbation du plan.
   - L'état machine d'orchestration (`last_processed_comment_id`, mandat signé contenant `spec_sha` et `approved_by`, statut `active|cancelled`, compteurs de tentatives par ticket) est stocké sous forme d'objets Git versionnés dans une référence dédiée **`refs/epure/state/<issue-number>`**, invisible dans les branches de code (`refs/heads/*`).
   - Les mises à jour de `refs/epure/state/<issue-number>` utilisent le *compare-and-swap* atomique de l'API Git GitHub (vérification de l'ancien SHA), empêchant toute condition de course sans base de données externe.
   - Un encadré Markdown lisible est synchronisé en haut du corps de l'issue de pilotage pour la visibilité humaine, tandis que `refs/epure/state/<issue-number>` demeure la source de vérité cryptographique et atomique.

## Conséquences

- Les branches `dev`, `main`, `feature/*` et `task/*` restent strictement propres de tout fichier JSON de plomberie d'orchestration.
- Aucun commentaire humain n'est perdu lors de rafales de messages sur une même issue.

## Références

Q6, Q16, Q33, Q34, Q46, Q75, Q76 ; ADR-0006, ADR-0013.
