---
status: superseded
---
# Isoler le contrôleur d’agents du cycle de release applicatif (superseded)

> Remplacé par [ADR-0008](0008-reusable-workflows-et-custom-actions-publics.md) : exécution locale via `workflow_call`, sans `repository_dispatch` obligatoire.

## Contexte

Les événements `issue_comment` et `repository_dispatch` démarrent le workflow présent sur la branche par défaut du dépôt récepteur. Cela oblige à disposer d'un point d'entrée sur cette branche, pas à y maintenir le moteur d'agents.

Le cycle de release applicatif est `dev` → `main` en fast-forward, à déclenchement humain. Faire dépendre les évolutions du contrôleur des releases applicatives créerait un couplage artificiel.

## Options étudiées

1. **Même dépôt, branche par défaut `main`** : simplicité, mais versions des outils couplées à la release applicative.
2. **Même dépôt, branche orpheline `automation`** : historique indépendant possible, mais maintien d'un dispatcher minimal sur la branche par défaut, déclenchement ciblant `automation`, protection et maintenance plus complexes.
3. **Dépôt `dev-automation` séparé** : code du contrôleur, policies, skills et jobs indépendants ; chaque repo applicatif garde un point d'entrée minimal (ou un webhook externe) pour relayer les événements.

## Décision acceptée — Q21

Privilégier un dépôt d'automatisation distinct, avec une GitHub App à jetons d'installation éphémères. Chaque dépôt applicatif maintient uniquement un workflow relais minimal sur sa branche par défaut. Ce relais transmet un identifiant d'événement au dépôt central, où le contrôleur revérifie la source, les permissions (`write`+), les contraintes de budget et l'état GitHub avant de traiter la demande. Les workflows `repository_dispatch` du dépôt central résident sur sa branche par défaut.

Le relais ne transmet pas de texte d'issue interprété comme commande shell et n'exécute pas de code de branche non fiable avec les secrets. **Contrainte d'autorisation GitHub :** appeler `repository_dispatch` exige `contents: write` sur le dépôt récepteur avec un jeton GitHub App, alors que `workflow_dispatch` demande `actions: write`. Restreindre le jeton au seul dépôt d'automatisation et protéger ce dépôt contre toute écriture de branche non autorisée. Le contrôleur revalide toujours les événements en relisant GitHub ; le simple payload reçu n'est pas une preuve d'autorisation. Le pipeline de release de l'application reste indépendant. Une autre option est un `workflow_call` inter-repos, en pin SHA, mais l'exécution a alors le contexte et les privilèges du workflow appelant : ce n'est pas une isolation équivalente à un dispatch inter-dépôts.

## Conséquences

- Avantages : cadence de versionnement indépendante, orchestration réutilisable pour plusieurs projets, sécurité et droits mieux explicités.
- Coûts : un repo supplémentaire, accès inter-repos à configurer, idempotence et suivi du dispatch, maintien du workflow relais dans chaque dépôt applicatif.
- **Statut : accepté (Q21).** La visibilité du dépôt central, ses identités GitHub App et sa politique de configuration restent à préciser.
