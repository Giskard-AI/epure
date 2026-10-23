---
status: accepted
---
# Promotion manuelle, sans réécriture, de dev vers main

`main` représente la dernière release stable et `dev` la branche d'intégration. Une promotion de `dev` vers `main` est déclenchée explicitement par une personne autorisée. Elle doit être **strictement fast-forward** : le commit courant de `main` doit être un ancêtre du commit de `dev`, puis le pointeur `main` est avancé au SHA validé, sans ajout d'un commit de merge ni rebase ni squash.

Le contrôle doit porter sur une révision précise de `dev` : tests et validations requis au vert, vérification de l'ascendance, absence de changements de pointeurs entre validation et publication (compare-and-swap ou contrôle d'échec sur mise à jour concurrente) et identité de release dotée du strict minimum de droits. Le GitHub UI ne fournit pas un merge FF strict : le mode « Rebase and merge » réécrit les commits. L'autorisation de pousser vers `main` doit être conçue avec ses règles de protection/rulesets, et non en ouvrant une dérogation générale aux agents.

Les ADR acceptés sont intégrés en premier lieu à `dev` et publiés dans `main` au rythme des releases. Ainsi, chaque SHA stable a une documentation historisée cohérente avec le code livré, qui distingue les décisions cibles des fonctionnalités réellement implémentées.

Les hotfix urgents sur `main` sont réalisés manuellement, puis réintégrés dans `dev` avant la prochaine promotion, afin que `main` demeure ancêtre de `dev`. Une release promeut tout le SHA validé de `dev` : aucune sélection de tickets ou cherry-pick lors de la promotion ; les fonctionnalités à différer utilisent des feature flags si nécessaire.

La préférence retenue pour l'interface de release est une GitHub Action `workflow_dispatch` lancée explicitement par un humain autorisé. Elle devra vérifier la révision de `dev` et les checks requis, mettre à jour `main` sans forçage, puis taguer le commit effectivement publié et créer ou retrouver de manière idempotente la GitHub Release associée. L'autorisation d'écriture sur `main` est réservée au composant de release et ne doit pas bénéficier aux agents d'implémentation.

**Points encore à spécifier** : politique de versionnement des tags, approbation éventuelle via environnement protégé, privilèges exacts du composant de release, reprise d'une publication partielle et éventuel déploiement.
