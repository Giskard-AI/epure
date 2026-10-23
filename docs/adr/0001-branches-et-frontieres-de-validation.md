---
status: accepted
---
# Branches par fonctionnalité et frontière de validation humaine

Le développement utilise `main` comme branche stable, `dev` comme branche d'intégration partagée, une branche `feature/*` par plan approuvé issue de `dev`, et des branches `task/*` par ticket issues de leur branche de fonctionnalité. Une approbation humaine du plan autorise l'exécution de ses tickets. Le développement des tickets peut être parallèle, mais leur intégration à la branche `feature/*` est sérialisée et exige une CI valide sur l'état réellement intégré ainsi qu'une revue automatique indépendante positive. La PR `feature/*` vers `dev` exige une validation humaine ; les releases `dev` vers `main` sont distinctes, initiées manuellement et exclusivement par fast-forward sans réécriture des commits.

Cette organisation privilégie l'autonomie à l'intérieur d'un périmètre fonctionnel approuvé sans déléguer à l'IA la validation de l'intégration partagée. Les modifications sensibles (notamment workflows, permissions, gestion des secrets, migrations destructives) ne sont jamais intégrées automatiquement, même dans une branche `feature/*`.

Avant la PR finale d'une fonctionnalité vers `dev`, la branche `feature/*` incorpore les dernières modifications de `dev` et repasse ses contrôles d'intégration. Une fonctionnalité dont les tickets obligatoires ne sont pas tous résolus peut faire l'objet d'une PR en brouillon, mais ne peut pas être promue comme prête au merge.
