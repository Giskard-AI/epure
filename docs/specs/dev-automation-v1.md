# EPURE (`Giskard-AI/epure`) — Spécification fonctionnelle et technique V1

**Statut :** publiée sur GitHub Issues ([#1](https://github.com/Giskard-AI/epure/issues/1)) avec le label `ready-for-agent`.  
**Origine :** entretien `/grill-with-docs` (Q1–Q83), glossaire du domaine et ADR-0001 à ADR-0025.  
**Périmètre :** framework open source GitHub-first de développement semi-automatisé (`EPURE` — *Engineered Planning, Unified Review & Execution* / *Élaboration de Plans, Usinage, Revue et Exécution*), distribué sous forme de Reusable Workflows, de Custom Actions TypeScript (Node.js 24 LTS) et de skills.  
**Frontière de test privilégiée :** événement GitHub → autorisation et état vérifiés (`refs/epure/state/*`) → exécution isolée → effets observables dans GitHub.

## Problem Statement

Un mainteneur de dépôt GitHub souhaite déléguer une grande partie du développement logiciel à des agents IA, depuis la clarification d'une demande jusqu'à l'intégration des tickets et à leur review, tout en conservant des validations humaines explicites aux frontières qui engagent le projet. Aujourd'hui, relier les échanges sur les issues, les skills de planification, les branches de travail, les dépendances, la CI, les reviews et les releases demande des interventions manuelles et des assemblages difficiles à reproduire.

Cette automatisation doit rester utilisable sur des dépôts GitHub publics, sans serveur central obligatoire, avec les runners, comptes LLM et identités GitHub du projet consommateur. Elle doit être publiable comme outil open source autonome et réutilisable par des tiers, y compris dans leurs projets privés lorsque GitHub et leurs droits le permettent.

Les risques principaux sont les exécutions non autorisées depuis des contributions publiques, l'exfiltration de credentials par du code exécuté, les merges sur des versions non contrôlées, les divergences documentaires entre branches, les répétitions d'opérations après échec et les boucles d'agents. La production de code ne doit pas pouvoir contourner les validations, les règles de sécurité ou les protections de branches.

## Solution

`EPURE` (`Giskard-AI/epure`) est un **dépôt public indépendant** qui distribue des **Reusable Workflows** pour les parcours complets et des **Custom Actions TypeScript pré-bundlées (Node.js 24 LTS)** pour les capacités unitaires. Les deux sont des interfaces publiques supportées dès la V1. Les workflows partagés s'exécutent sur les runners des **dépôts appelants**, avec leur configuration, leurs identités GitHub App et leurs clés LLM ; aucun relais permanent ni serveur d'orchestration n'est requis.

Un skill local `setup-repo` appuyé sur une CLI TypeScript, idempotent et utilisable en simulation, configure chaque dépôt consommateur : workflows, protections et GitHub Repository Rulesets, deux GitHub Apps séparées (Agent App et Release App), CI, Renovate, zizmor, modèles et intégrations optionnelles. Seuls les utilisateurs disposant d'une permission GitHub effective `write` ou supérieure peuvent lancer un agent ou approuver les transitions privilégiées. Les événements internes peuvent poursuivre une chaîne **déjà autorisée**, mais jamais créer une autorisation nouvelle.

Une demande se pilote depuis une **issue de pilotage**. Les skills de Matt Pocock guident clarification, décisions, spécification et décomposition en **tickets d'implémentation**. Les commentaires GitHub sont l'interface de dialogue (traités en lot séquentiel via curseur `last_processed_comment_id`) ; les livrables documentaires métiers sont versionnés sur `plan/* → dev`, tandis que l'état machine d'orchestration et le mandat signé résident hors branches applicatives dans `refs/epure/state/<issue-number>` avec un tableau de bord lisible synchronisé dans l'issue. Pour une fonctionnalité frontend, Impeccable complète le cadrage UX/UI. Un prototype exploratoire peut être produit pour lever une incertitude ; son code n'est pas repris dans la production. La **spec et le graphe de tickets** sont soumis ensemble à approbation humaine avant exécution.

Après approbation, les agents développent des tickets sur des branches `task/*` liées à une branche `feature/*`, à l'intérieur d'un conteneur isolé communiquant avec le modèle uniquement via un **proxy LLM de sandbox** local sur le runner (sans secret dans les variables d'environnement des processus de test/build). La CI et une **revue indépendante** liée à un SHA contrôlent chaque PR ; les tickets ordinaires peuvent être intégrés automatiquement dans `feature/*` de manière sérialisée. Les modifications sensibles sont exclues de l'auto-merge. L'intégration `feature/* → dev` exige une approbation humaine réelle. Les dépendances sont réconciliées après intégration. La publication `dev → main` est **déclenchée manuellement** derrière un environnement `release` protégé, en **fast-forward strict** via la seule `Release App` déclarée en *Bypass Actor* du Ruleset, puis taguée avec un tag SemVer `vMAJOR.MINOR.PATCH` strictement immuable et publiée comme GitHub Release.

Les fournisseurs LLM assurent seuls la **gestion financière** (tarifs, crédits, plafonds éventuels) ; `EPURE` applique uniquement des garde-fous opérationnels. Les composants exposent leur provenance, leur état et leurs erreurs par des effets GitHub vérifiables. Les tiers sont crédités et leurs licences conservées.

## User Stories

### Installation, distribution et configuration

1. En tant que mainteneur de `dev-automation`, je veux publier le code source sous Apache-2.0 afin que d'autres projets puissent l'utiliser et le modifier commercialement ou non.
2. En tant que mainteneur de projet, je veux consommer un Reusable Workflow public afin de déléguer un processus entier sans copier sa logique.
3. En tant que mainteneur de projet, je veux consommer une Custom Action publique seule afin de réutiliser une capacité sans installer le workflow complet.
4. En tant que mainteneur de projet, je veux figer une version distribuée par SHA Git complet afin d'éviter les mises à jour inattendues.
5. En tant que mainteneur de `dev-automation`, je veux publier des versions SemVer et des contrats d'interface stables afin de rendre les mises à niveau prévisibles.
6. En tant que mainteneur de projet, je veux installer le système avec un skill local guidé afin de ne pas devoir écrire manuellement tous les workflows et paramètres.
7. En tant que mainteneur de projet, je veux simuler l'installation et la rejouer sans duplication afin de pouvoir vérifier les changements avant application.
8. En tant qu'administrateur GitHub, je veux enregistrer et installer mes propres GitHub Apps afin de garder le contrôle des identités techniques.
9. En tant qu'administrateur GitHub, je veux séparer l'Agent App de la Release App afin qu'un agent de développement ne puisse pas publier de release.
10. En tant qu'administrateur GitHub, je veux approuver les opérations sensibles du bootstrap afin de ne pas déléguer implicitement des pouvoirs administratifs.
11. En tant que mainteneur de projet, je veux définir les moteurs, modèles et limites opérationnelles autorisés pour mon dépôt afin d'adapter son comportement.
12. En tant que responsable d'organisation, je veux mutualiser les secrets et variables autorisés entre dépôts sans affaiblir leurs politiques de sécurité.
13. En tant que mainteneur de projet, je veux que l'installation vérifie les checks et protections indispensables afin qu'aucun auto-merge ne démarre sur un dépôt non sécurisé.
14. En tant que contributeur externe, je veux installer la même distribution avec mes propres credentials afin de ne dépendre d'aucun service tenu par l'auteur du projet.
15. En tant que mainteneur de projet, je veux recevoir des PR Renovate pour mettre à niveau les références GitHub Actions épinglées afin de choisir quand adopter les nouvelles versions.

### Interaction, planification et documentation

16. En tant que contributeur autorisé, je veux demander une planification par commentaire sur une issue afin de lancer le parcours depuis GitHub.
17. En tant que contributeur non autorisé, je veux pouvoir ouvrir une issue ordinaire afin de proposer une fonctionnalité sans déclencher de dépenses ou d'actions privilégiées.
18. En tant que mainteneur, je veux que le contrôleur vérifie les permissions GitHub effectives à chaque transition sensible afin qu'un label ou un rôle affiché ne serve pas de preuve d'autorisation.
19. En tant que contributeur autorisé, je veux répondre normalement aux questions de l'agent dans la même issue afin de poursuivre l'entretien sans répéter une commande à chaque message.
20. En tant que contributeur autorisé, je veux que les réponses déjà données soient conservées afin de ne pas devoir reclarifier les décisions lors des runs suivants.
21. En tant que mainteneur, je veux que les commentaires nouveaux soient traités en ordre, au plus une exécution active par issue, afin d'éviter des décisions contradictoires.
22. En tant que mainteneur, je veux que les commentaires modifiés après traitement ne réécrivent pas l'historique afin que les corrections soient des événements explicites.
23. En tant que mainteneur, je veux que les messages des bots ne soient pas interprétés comme des commandes humaines afin d'éviter les boucles.
24. En tant que contributeur autorisé, je veux que le skill approprié soit sélectionné pour mon problème afin d'utiliser clarification, spécification, tickets ou exploration de décisions sans procédure manuelle.
25. En tant que contributeur autorisé, je veux voir les questions d'incertitude avant l'approbation afin de savoir quels choix restent ouverts.
26. En tant que mainteneur, je veux que les ADR, le glossaire et les specs en cours soient versionnés dans une branche `plan/*` afin de pouvoir inspecter et reprendre une planification.
27. En tant que mainteneur, je veux distinguer l'architecture cible de l'architecture effective afin de ne pas prendre une décision approuvée pour une fonctionnalité déjà livrée.
28. En tant que mainteneur, je veux que la documentation acceptée soit intégrée à `dev` et atteigne `main` au moment de la release afin de conserver un historique cohérent avec le code.
29. En tant qu'agent d'implémentation, je veux disposer d'une référence documentaire immuable pour mon ticket afin de connaître les exigences qui m'ont été assignées.
30. En tant que mainteneur, je veux détecter les décisions ultérieures incompatibles avec une tâche en cours afin de réévaluer son implémentation avant intégration.
31. En tant que contributeur autorisé, je veux obtenir une spec et un graphe de tickets dépendants avant mon approbation afin de comprendre précisément le travail qui sera déclenché.
32. En tant que mainteneur, je veux approuver ou refuser explicitement le plan complet afin qu'un brouillon ne démarre pas d'implémentation de lui-même.
33. En tant que mainteneur, je veux revoir un changement significatif de périmètre ou d'ADR afin que l'autorisation initiale ne s'étende pas silencieusement.

### Design et prototypage

34. En tant que responsable frontend, je veux que la clarification fonctionnelle et Impeccable `shape` échangent dans la même issue afin de conserver une seule discussion et les décisions déjà prises.
35. En tant que designer, je veux versionner le contexte produit, le design system et les décisions par interface afin qu'ils guident les agents et leurs reviews.
36. En tant que responsable frontend, je veux qu'un prototype soit proposé lorsqu'une incertitude UX ou de modèle d'état ne peut être levée par discussion afin d'obtenir une preuve concrète avant décision.
37. En tant que mainteneur, je veux qu'un prototype exploratoire reste sur une branche distincte afin de ne pas le confondre avec une implémentation de production.
38. En tant que mainteneur, je veux que les agents implémentent depuis la base de code approuvée, sans copier le code d'un prototype, afin d'éviter d'hériter de raccourcis expérimentaux.
39. En tant que responsable produit, je veux voir les captures et artifacts d'un prototype dans l'issue afin de l'évaluer sans infrastructure supplémentaire.
40. En tant que responsable produit, je veux activer explicitement une preview statique GitHub Pages lorsque c'est utile afin de tester les interactions dans un navigateur.
41. En tant que responsable produit, je veux réutiliser une solution de preview déjà installée dans mon projet afin d'éviter un second hébergeur.
42. En tant que responsable sécurité, je veux empêcher qu'une preview partage l'origine de production ou publie des secrets/données personnelles afin de réduire les risques d'exposition.
43. En tant que mainteneur, je veux que les previews hébergées expirent au bout de 14 jours par défaut afin de ne pas accumuler des sites temporaires.
44. En tant que mainteneur frontend, je veux activer éventuellement des comparaisons visuelles desktop/mobile afin de repérer des régressions de rendu.
45. En tant que mainteneur frontend, je veux que les nouvelles violations bloquantes détectées par Impeccable empêchent le merge par défaut afin d'imposer mes règles de qualité visuelle objectivables.
46. En tant que mainteneur frontend, je veux pouvoir désactiver explicitement Impeccable ou documenter une exception afin d'adapter le contrôle à mon projet.
47. En tant que reviewer, je veux que les critiques purement esthétiques restent informatives afin de ne pas transformer des préférences subjectives en blocage automatique.

### Exécution, intégration et review

48. En tant que mainteneur, je veux que chaque ticket approuvé dispose d'une branche `task/*` associée à sa `feature/*` afin de limiter la portée des modifications.
49. En tant que mainteneur, je veux que les tickets indépendants puissent être développés en parallèle afin de réduire le temps d'attente.
50. En tant que mainteneur, je veux que les merges sur une même `feature/*` soient sérialisés afin que chaque intégration parte d'un état connu.
51. En tant qu'agent d'implémentation, je veux utiliser Pi ou Codex derrière un contrat commun afin de changer de moteur selon la phase et le projet.
52. En tant que mainteneur, je veux que les commandes et tests sur du code non fiable soient isolés des credentials afin de limiter les effets d'une compromission.
53. En tant que mainteneur, je veux qu'un publisher distinct produise commits, commentaires et PR après validation des résultats de l'agent afin de séparer génération de code et opérations privilégiées.
54. En tant que reviewer, je veux examiner spec, diff, résultats des tests et SHA dans une session indépendante afin de ne pas me fier au jugement de l'implementer.
55. En tant que mainteneur, je veux publier la review IA comme check GitHub lié à un SHA afin que les protections de branches puissent la vérifier.
56. En tant que mainteneur, je veux que toute modification de la branche source invalide une review devenue obsolète afin qu'aucune approbation IA ne porte sur le mauvais code.
57. En tant que mainteneur, je veux choisir une politique de base `strict` ou `relaxed` afin de décider si une branche doit être mise à jour avant merge.
58. En tant que mainteneur, je veux qu'une intégration en politique `relaxed` teste la combinaison avec la dernière cible afin qu'une absence de conflit textuel ne soit pas prise pour une compatibilité.
59. En tant que mainteneur, je veux utiliser une Merge Queue GitHub native lorsqu'elle est disponible afin de limiter le code de sérialisation à maintenir.
60. En tant que mainteneur, je veux que le contrôleur prenne en charge la sérialisation quand Merge Queue est indisponible afin de conserver le comportement sur les dépôts publics personnels.
61. En tant que mainteneur, je veux que les PR de tickets ordinaires puissent être mergées automatiquement dans `feature/*` après checks verts afin de limiter les validations humaines de routine.
62. En tant que mainteneur, je veux exclure automatiquement les changements sensibles de ce merge afin de réserver ces modifications à une approbation humaine.
63. En tant que développeur humain, je veux pouvoir modifier une branche de ticket créée par un agent afin de collaborer sans perdre la CI ou la review indépendante.
64. En tant que mainteneur, je veux qu'une feature incomplète puisse ouvrir une PR brouillon vers `dev` afin de visualiser son avancement sans autoriser le merge.
65. En tant que mainteneur, je veux que la PR `feature/* → dev` passe les contrôles et une véritable review humaine afin de garder la décision d'intégration partagée.
66. En tant que mainteneur, je veux que la branche feature intègre les changements récents de `dev` avant sa validation finale afin de détecter les incompatibilités.
67. En tant que mainteneur, je veux suspendre une feature après régression d'intégration afin d'éviter de multiplier les merges défectueux.
68. En tant que mainteneur, je veux créer un ticket correctif sans réécrire l'historique partagé afin de conserver une trace exploitable de l'incident.

### Dépendances, événements et résilience

69. En tant que mainteneur, je veux représenter le découpage et les dépendances avec les relations natives d'issues GitHub afin d'éviter une base de graphe parallèle.
70. En tant qu'agent, je veux savoir quelles tâches obligatoires sont prêtes, bloquées, terminées ou dispensées afin de n'exécuter que les travaux éligibles.
71. En tant que mainteneur, je veux que le merge d'un ticket réévalue ses dépendants afin que les tâches suivantes deviennent disponibles automatiquement.
72. En tant que mainteneur, je veux distinguer une issue fermée sans résolution d'une tâche réellement satisfaisante afin de ne pas lever des blocages à tort.
73. En tant que mainteneur, je veux que les approbations, événements et actions aient des identifiants stables afin que les retries n'ouvrent pas d'issues ou PR en double.
74. En tant que mainteneur, je veux reconstruire l'état à partir de GitHub après un incident afin de reprendre sans base de données externe.
75. En tant que mainteneur, je veux que la réconciliation périodique corrige les transitions manquées afin de ne pas dépendre de la livraison parfaite des webhooks.
76. En tant que mainteneur, je veux annuler un plan en empêchant nouvelles exécutions et merges automatiques afin d'arrêter immédiatement un travail devenu inutile.
77. En tant que mainteneur, je veux conserver les branches et traces d'un plan annulé afin de pouvoir auditer ou décider explicitement d'une reprise.
78. En tant que mainteneur, je veux que trois corrections infructueuses déclenchent `needs-human` sans arrêter les tickets indépendants afin d'éviter les boucles infinies.
79. En tant que mainteneur, je veux que les rate limits API provoquent des retries bornés avec backoff afin de résister aux pannes temporaires.
80. En tant que mainteneur, je veux que les quotas/credentials LLM bloquants suspendent les tâches sans changer de fournisseur ou clé automatiquement afin de respecter mes limites financières externes.

### Dépendances, audits et releases

81. En tant que mainteneur, je veux que Renovate ouvre ses PR vers `dev` afin de maintenir les dépendances au même niveau que le code en intégration.
82. En tant que mainteneur, je veux activer explicitement la migration automatique des PR Renovate en échec afin de déléguer les adaptations documentées sans déclenchement libre par un tiers.
83. En tant que responsable sécurité, je veux vérifier la provenance réelle d'une PR Renovate avant d'exécuter l'agent de migration afin d'empêcher l'usurpation par nom ou label.
84. En tant qu'agent de migration, je veux distinguer une panne d'infrastructure d'une incompatibilité de code afin de ne pas modifier l'application pour une panne de runner.
85. En tant que mainteneur, je veux approuver humainement toute PR Renovate vers `dev`, même corrigée par un agent, afin de contrôler l'adoption des dépendances.
86. En tant que responsable sécurité, je veux que zizmor vérifie les GitHub Actions afin de détecter les configurations risquées.
87. En tant que mainteneur de `dev-automation`, je veux que l'audit déterministe iFixAi contrôle les changements de logique d'autorisation/délégation afin de prévenir les régressions de sécurité.
88. En tant qu'auditeur, je veux exploiter des traces structurées minimisées et à rétention limitée afin d'analyser les autorisations et transitions sans exposer les secrets.
89. En tant que mainteneur, je veux savoir quel agent, rôle, modèle et version a produit une opération afin de comprendre le déroulement d'une issue ou d'une PR.
90. En tant qu'auditeur, je veux lancer manuellement des tests comportementaux iFixAi utilisant un LLM afin d'évaluer les cas adversariaux sans les imposer à toutes les PR.
91. En tant que release manager, je veux déclencher volontairement une Action de release en choisissant une version SemVer afin de contrôler le moment de publication.
92. En tant que release manager, je veux que `dev → main` soit un fast-forward strict du SHA validé afin de conserver exactement l'historique intégré.
93. En tant que release manager, je veux que la release représente tout `dev` afin d'éviter des sélections manuelles imprévues de fonctionnalités.
94. En tant que release manager, je veux que le tag et la GitHub Release pointent exactement sur le SHA promu afin de garantir la traçabilité des livraisons.
95. En tant que release manager, je veux pouvoir reprendre une promotion partiellement réussie sans créer de doublon afin de récupérer proprement après incident.
96. En tant que release manager, je veux appliquer manuellement un hotfix sur `main`, puis réintégrer ses commits dans `dev`, afin de préserver la possibilité de futurs fast-forwards.
97. En tant que responsable sécurité, je veux que l'Agent App ne puisse jamais exercer les permissions de Release App afin de préserver la séparation de privilèges.
98. En tant que développeur tiers, je veux retrouver les licences, notices et versions des composants Matt Pocock, Impeccable et iFixAi afin de redistribuer légalement le framework.

## Implementation Decisions

1. **Distribution sans exécution centrale (`Giskard-AI/epure`).** Le dépôt public `Giskard-AI/epure` distribue des Reusable Workflows multi-jobs et des Custom Actions mono-étape écrites en TypeScript strict (Node.js 24 LTS) et pré-bundlées (sans `npm install` requis à l'exécution chez le consommateur), qui s'exécutent dans le contexte des dépôts consommateurs. Les deux surfaces possèdent des contrats publics documentés : paramètres d'entrée, sorties, erreurs, besoins de secrets, permissions, compatibilité et exemples. Les dépendances sont épinglées par SHA Git complet (`uses: Giskard-AI/epure/.../@<sha> # vX.Y.Z`) dans les projets consommateurs ; les releases publient uniquement des tags SemVer `vMAJOR.MINOR.PATCH` strictement immuables (aucun tag mobile `v1`). Les composants internes ne constituent pas une API stable. [ADR-0008, ADR-0011, ADR-0023, ADR-0025]
2. **Bootstrap local.** Un skill de configuration lancé localement (s'appuyant sur une CLI TypeScript dédiée) effectue inspection des prérequis, simulation, installation et vérification ; il est idempotent et soumet les opérations sensibles à confirmation. Chaque organisation utilisatrice possède une Agent App et une Release App distinctes, éventuellement installées sur plusieurs dépôts explicitement autorisés. Aucun secret ne transite dans une issue ou dans les prompts. [ADR-0009, ADR-0010, ADR-0023]
3. **Configuration par dépôt.** Une configuration versionnée (`.github/agents.yml`) expose les choix locaux autorisés (harness, modèle, politique `strict`/`relaxed`, limites de concurrence et de temps, fonctionnalités facultatives) avec les valeurs par défaut suivantes : `max_code_fix_attempts: 3`, `max_transient_api_retries: 4` (backoff exponentiel 5s → 15s → 45s → 120s), `job_timeout_minutes: 60` pour l'implémentation (30 min pour review/triage), `max_concurrent_tasks_per_feature: 3`, et `trace_retention_days: 30` (14 jours pour les previews hébergées). La politique de sécurité imposée par les workflows ne peut être assouplie par les données provenant d'un commit ou d'une PR non approuvés. Les modifications à fort effet de privilège nécessitent un processus d'approbation. [ADR-0010, ADR-0011, ADR-0023]
4. **Réception et autorisation.** Le dispatcher traite les événements GitHub et les commandes humaines, puis obtient la permission effective de leur auteur via l'API GitHub sur le dépôt cible ; seule une permission `write` ou supérieure peut initier ou approuver une opération privilégiée. Les labels, les noms de bots et `author_association` ne suffisent pas. Les commentaires générés par des bots sont ignorés en tant que nouvelles commandes humaines. [ADR-0004, ADR-0015, ADR-0017]
5. **Délégation bornée et référence Git d'état (`refs/epure/state/<issue-number>`).** L'approbation d'un plan crée un mandat signé portant sur une version donnée de sa spec (`spec_sha`) et de son graphe de tickets. Cet état machine d'orchestration (curseur `last_processed_comment_id`, mandat `spec_sha`, `approved_by`, statut `active|cancelled`, compteurs de tentatives par ticket) est stocké dans une référence Git dédiée hors branches applicatives (`refs/epure/state/<issue-number>`) mise à jour par *compare-and-swap* atomique Git, doublée d'un tableau de bord Markdown synchronisé en haut de l'issue de pilotage (sans polluer `dev` ni `main`). Chaque continuation technique doit démontrer qu'elle est dans ce mandat et que le plan est toujours actif. Une replanification majeure (périmètre, ADR, dépendances) exige une nouvelle approbation. [ADR-0001, ADR-0006, ADR-0015, ADR-0024]
6. **Source de vérité GitHub.** Les issues, relations natives parent/enfant et bloqueur/bloqué, références `refs/epure/state/*`, PR, commits, checks et approbations définissent l'état réel. Les états d'interface sont des projections recalculables, pas une seconde autorité. Les identifiants de plan, ticket, run et publication sont stables. Les écritures sont idempotentes et la réconciliation périodique traite les événements manqués. [ADR-0006, ADR-0024]
7. **Concurrence et rattrapage en lot par curseur.** Un seul run actif par issue à la fois (`concurrency: issue-<N>` avec `cancel-in-progress: false`). À son démarrage, le job lit et traite séquentiellement en lot tous les nouveaux commentaires humains postés depuis `last_processed_comment_id`, évitant toute perte lorsque GitHub Actions fusionne la file d'attente au-delà de deux événements ; les commentaires édités ne déclenchent pas de réécriture de décisions. L'implémentation de tickets indépendants peut être parallèle mais l'intégration dans une même feature est sérialisée. [ADR-0013, ADR-0014, ADR-0024]
8. **Contexte documentaire.** Chaque issue de pilotage possède une branche de planification (`plan/<issue>`) pour son glossaire, ses ADR proposés, ses documents produit/design et sa spec. Après validation, la documentation métier est approuvée via PR vers `dev`. Les tickets référencent une révision documentaire approuvée. Les agents distinguent une architecture cible acceptée d'une architecture effective sur la branche et vérifient les évolutions significatives des ADR. [ADR-0002, ADR-0021, ADR-0022, ADR-0024]
9. **Routage des skills.** Le parcours de base est clarification avec les skills Matt Pocock, puis spec, tickets et approbation humaine avant implémentation. Une interface frontend ajoute Impeccable `shape`. Un prototype exploratoire est proposé lorsqu'une question de conception ne se résout pas par la discussion ; le résultat nourrit la spec mais pas le code de production. [ADR-0021, ADR-0022]
10. **Graphe des tâches.** Les sous-issues correspondent au découpage fonctionnel et les dépendances aux prérequis d'exécution ; la fermeture seule n'est pas une preuve de complétion. Le reconciler ne libère les dépendants qu'après une résolution satisfaisante autorisée et vérifiée. Une feature incomplète peut proposer une PR brouillon, pas se déclarer intégrable. [ADR-0001, ADR-0006]
11. **Branches et règles de merge.** `main` conserve le code stable, `dev` l'intégration, `feature/*` une fonction approuvée, `task/*` ses tickets. Les PR `task/* → feature/*` ordinaires peuvent être intégrées automatiquement après CI, review IA et test du résultat combiné. Les PR `feature/* → dev` exigent une review humaine GitHub. Aucun agent ne pousse directement sur `dev` ou `main`. [ADR-0001, ADR-0011]
12. **Exceptions sensibles.** Une modification de workflows, de permissions, de secrets ou une migration destructrice désactive l'auto-merge et exige une validation humaine, même au niveau ticket. Les protections et exceptions sont contrôlées par le publisher en plus des règles GitHub, jamais laissées à la discrétion du modèle. [ADR-0001, ADR-0004]
13. **CI et validation d'intégration.** La présence d'une CI pertinente et requise conditionne tout auto-merge. La review IA indépendante reçoit spec, diff, SHA et checks, sans raisonnement privé de l'implementer ; elle ne peut modifier le code ni merger. Le verdict est publié dans un check identifiable lié à la révision examinée, via une identité autorisée. Un nouveau commit invalide le verdict précédent. Les changements de base sont gérés par les politiques `strict` et `relaxed` et un test du résultat combiné. Merge Queue native si disponible ; sérialisation contrôlée sinon. [ADR-0013, ADR-0014, ADR-0017]
14. **Séparation des privilèges et proxy LLM de sandbox.** L'exécuteur d'agent ne reçoit aucun token GitHub en écriture. Un composant publisher distinct valide et applique uniquement des opérations explicitement permises avec un jeton d'installation court et restreint. Un proxy/sidecar local sur le runner détient seul en mémoire la clé API LLM, tandis que l'agent et les sous-processus de test/build du dépôt consommateur s'exécutent dans un conteneur isolé sans aucun secret dans leurs variables d'environnement. L'absence d'isolation effective provoque un échec fermé (*fail-closed*). [ADR-0004, ADR-0011, ADR-0023]
15. **Moteurs LLM.** Pi est le moteur par défaut et Codex une alternative dès la V1 (invoqués via Composite Actions épinglées derrière un adaptateur TypeScript commun couvrant lancement, contexte autorisé, artifacts et résultat structuré). Les erreurs API transitoires sont reprises avec un nombre limité d'essais (`max_transient_api_retries: 4`) et backoff exponentiel ; les blocages de clé, crédit ou quota suspendent sans basculer vers un autre fournisseur. Aucune estimation comptable ni plafond monétaire interne n'est ajouté ; ces contrôles relèvent exclusivement du fournisseur. [ADR-0012, ADR-0016, ADR-0023]
16. **Reprise et annulation.** Au plus trois corrections de code infructueuses par ticket (`max_code_fix_attempts: 3`), puis `needs-human`. Les autres tickets indépendants continuent ; ceux ayant une dépendance restent bloqués. Un plan annulé interdit nouveaux runs et merges via `refs/epure/state/<issue>`, annule les jobs dans la mesure du possible et préserve les objets GitHub. Une régression après merge bloque les intégrations ultérieures sur la feature et provoque une tâche corrective. [ADR-0006, ADR-0012, ADR-0017, ADR-0023, ADR-0024]
17. **Renovate et zizmor.** Renovate soumet les mises à jour sur `dev`. Un agent de migration n'est déclenché en cas d'échec que si `auto_migrate` est préalablement activé dans une configuration approuvée et si l'identité, le dépôt et la PR Renovate sont vérifiés. Il distingue panne d'infrastructure et rupture de compatibilité et peut consulter les guides de migration. La PR reste soumise à un humain. Zizmor analyse les workflows concernés. [ADR-0015, ADR-0016]
18. **Impeccable.** Les dépôts frontend disposent par défaut d'un contrôle bloquant sur les *nouvelles* violations couvrant : (1) le socle objectif par défaut (accessibilité vérifiable WCAG/ARIA/contraste/clavier, cassures de layout/overflow responsive, états obligatoires loading/error/empty manquants), ainsi que (2) toutes les règles et tokens ajoutés dans `DESIGN.md` et `.impeccable/surfaces/*.md`. L'opt-out est un choix approuvé et tracé ; les observations esthétiques subjectives restent informatives. Les régressions visuelles par captures sont optionnelles. Le skill et la Custom Action correspondants sont exposés publiquement. [ADR-0019, ADR-0020, ADR-0021, ADR-0023]
19. **iFixAi et audit.** Une Custom Action d'audit de trajectoires est publique. Les modifications du contrôle d'autorisation, de délégation et d'orchestration d'`EPURE` exécutent l'audit déterministe en CI sur des traces de référence. Les tests comportementaux LLM sont facultatifs. Les traces d'exploitation se limitent aux identifiants, transitions et décisions d'autorisation nécessaires, avec rétention limitée configurable (30 jours par défaut) et sans secrets. [ADR-0019, ADR-0020, ADR-0023]
20. **Prototypes et previews.** Les prototypes sont des livrables exploratoires distincts du code productif. Artifacts/captures disponibles par défaut ; GitHub Pages n'est activé qu'avec consentement. Un hébergement de preview existant peut être utilisé. Toute publication vérifie l'isolation de l'origine par rapport au site productif et l'absence de données personnelles/secrets ; à défaut, elle est refusée et le système revient aux artifacts. Les previews hébergées sont nettoyées après 14 jours par défaut. [ADR-0021, ADR-0022]
21. **Promotion et release via Repository Ruleset.** `setup-repo` configure un **GitHub Repository Ruleset** sur `main` et `refs/tags/v*` avec la seule `Release App` en *Bypass Actor*, associé à un GitHub Environment `release` protégé. La Release App valide une révision précise de `dev` et les checks requis, vérifie que le SHA de `main` est ancêtre du SHA promu, puis avance `main` par fast-forward strict (`git push origin dev:main --ff-only`) sans rebase, squash ou commit de merge. L'opération refuse un changement concurrent de révision non validée. Le tag SemVer immuable `vMAJOR.MINOR.PATCH` et la GitHub Release correspondent exactement au SHA publié ; une publication partiellement réussie peut être reprise sans doublon. L'intégralité de `dev` est publiée ; les hotfix manuels sur `main` sont réintégrés dans `dev` ensuite. [ADR-0005, ADR-0016, ADR-0025]
22. **Attribution et conformité.** Le code original est Apache-2.0 ; les copies et adaptations de composants tiers conservent licences, copyrights et notices. Les versions des skills Matt Pocock (MIT), d'Impeccable et d'iFixAi (Apache-2.0 pour les références retenues) sont inventoriées et épinglées. [ADR-0018, ADR-0019]

## Testing Decisions

**Seam principale :** déclencher un événement GitHub représentatif sur un dépôt de test et observer le résultat via l'API GitHub : création ou absence d'issue/PR, état des dépendances, checks, approbations, branches, tags et releases. Les vérifications doivent juger les effets et les invariants de sécurité, et non la formulation exacte des prompts ou l'agencement interne des modules. Pour garder les tests rapides, le seam doit accepter un fournisseur LLM de test et des réponses GitHub simulées, complétés par des tests d'intégration ciblés sur GitHub réel.

**Éléments contractuels testés :** workflow appelant et Reusable Workflows, Custom Actions publiques, contrôleur de transitions, vérificateur de permissions, adaptateurs Pi/Codex, publisher, réconciliation, contrôles Impeccable/iFixAi, action de release et installation locale. Les capacités de GitHub elles-mêmes sont exercées dans des dépôts fixtures ; aucun code applicatif tiers n'est nécessaire pour vérifier l'interface d'orchestration.

**Tests observables prioritaires :**

1. Un commentaire émis par un utilisateur `read`/`triage` n'entraîne ni appel LLM ni opération privilégiée ; une permission `write` effective le permet.
2. Un bot, un faux rôle `COLLABORATOR` et un label d'issue ne permettent pas de contourner l'autorisation.
3. Une demande de plan valide pose des questions puis reprend depuis son état documentaire versionné lors d'un run ultérieur.
4. Trois commentaires rapprochés sur la même issue sont traités une fois chacun et dans l'ordre ; les commentaires déjà traités ou édités ne déclenchent pas de nouvelle transition.
5. La spec, le graphe de tickets et les relations de dépendances existent avant l'approbation ; l'exécution n'est pas possible avant elle.
6. Après approbation, les tickets indépendants démarrent, tandis qu'un ticket bloqué n'est pas exécuté ; un ticket abandonné/fermé sans satisfaction ne libère pas son dépendant.
7. Une nouvelle décision d'architecture incompatible suspend les tâches concernées jusqu'à nouvelle autorisation, sans altérer la référence initiale.
8. L'agent ne peut ni pousser vers une branche protégée ni créer une release avec les credentials d'exécution ; seuls les publishers dédiés appliquent des sorties validées.
9. Une commande hostile contenue dans un test ou une contribution externe ne peut lire un secret LLM, un token GitHub App ou un identifiant de release ; faute de sandbox, le job échoue fermé.
10. Un agent Pi et un agent Codex reçoivent le même travail contractuel et rendent des sorties validables par le publisher.
11. Une PR de ticket ordinaire avec CI et review indépendantes vertes est intégrée à la dernière feature cible ; une modification sensible est bloquée avant auto-merge.
12. Une review positive est invalidée quand le SHA source change ; le check est émis par l'identité prévue et non par un acteur homonyme.
13. En mode `strict`, une branche obsolète ne merge pas ; en mode `relaxed`, elle ne merge qu'après vérification du résultat combiné sur la cible actuelle et absence de conflit.
14. Deux PR de tickets validées simultanément ne produisent pas une course de merges ; la seconde est recalculée/retestée après la première si besoin.
15. Une intervention humaine dans la branche de ticket déclenche CI et review IA sur la nouvelle révision.
16. Une feature incomplète peut ouvrir une draft PR mais pas obtenir le statut de merge éligible ; une feature prête exige une approbation humaine GitHub.
17. Une régression après merge gèle les merges suivants et ouvre un ticket correctif, sans force-push.
18. Une interruption après création de PR ou d'issue suivie d'un retry ne produit pas de doublon ; un rapprochement périodique résout l'état incomplet.
19. L'annulation d'un plan entre génération et publication empêche tout nouvel effet de bord, tout en conservant les traces et branches existantes.
20. Trois corrections de code infructueuses entraînent `needs-human` ; des tentatives de retry réseau n'épuisent pas ce compteur.
21. Un blocage fournisseur LLM suspend sans basculement de provider ; un 429 transitoire provoque un backoff borné.
22. Une PR imitant Renovate n'active pas le migrateur ; une PR Renovate attestée et l'option approuvée l'autorisent après panne CI pertinente.
23. Un échec réseau ou runner lors d'une PR Renovate entraîne retry de CI et non patch de code ; une rupture d'API documentée peut produire une proposition de correction soumise à approbation humaine.
24. Les nouvelles violations bloquantes Impeccable empêchent le merge sur frontend ; l'opt-out approuvé et une exception documentée se comportent comme prévu.
25. Une PR de `dev-automation` modifiant les contrôles d'accès exige un audit iFixAi déterministe vert ; un changement sans impact sur ces contrôles n'impose pas de campagne LLM.
26. Un prototype demandé pour une incertitude de conception produit un retour documenté et une preview ou artifact ; son code ne figure pas dans les branches de production.
27. GitHub Pages ne s'active pas sans consentement ; une preview avec origine partagée avec la production ou des données sensibles est refusée ; la suppression après rétention fonctionne.
28. Une release avec `main` ancêtre de `dev` et checks verts met `main` à jour par fast-forward strict, crée un tag SemVer et une Release au bon SHA.
29. Une release est refusée si `main` diverge, si `dev` change après validation, si le tag existe pour un autre SHA ou si la demande n'est pas autorisée.
30. Une panne entre fast-forward et création de GitHub Release reprend la même publication sans second tag ni doublon.
31. L'installation en dry-run n'apporte aucune mutation ; le second passage n'ajoute ni workflows ni Apps en double ; les protections insuffisantes bloquent l'auto-merge.
32. Les interfaces publiques sont testées depuis un dépôt fixture en appelant la version distribuée par SHA ; changements d'inputs/outputs et de permissions incompatibles sont détectés avant release majeure.
33. Les mentions de licence et notices des composants redistribués sont présentes dans les artifacts publiés et restent intactes après mises à niveau.

**Prior art :** le projet ne dispose pas encore d'un codebase identifié à inspecter ni de tests existants. Les tests ci-dessus constituent le contrat initial ; utiliser comme exemples de fixture les workflows GitHub Actions, les événements issus de la GitHub API, les checks GitHub et les CLI réels des moteurs, sans prétendre réutiliser des tests préexistants.

## Out of Scope

- Serveur central permanent, API/SaaS hébergé, base de données d'orchestration et service multi-tenant de publication de credentials.
- GitHub App publique partagée par le mainteneur du framework ; chaque consommateur détient ses deux Apps.
- Comptabilité interne des tokens facturés, calcul de coûts, budgets monétaires par ticket/feature ou garantie de plafond financier ; la gestion financière appartient aux fournisseurs LLM.
- Merge automatique de `feature/*` vers `dev` et promotion automatique de `dev` vers `main`.
- Exécution libre d'un agent par des contributeurs sans permission effective `write` sur le dépôt cible.
- Reprise automatique ou cherry-pick du code de prototypes dans les branches productives.
- Wiki, MkDocs, service externe obligatoire de previews ou environnement backend éphémère obligatoire.
- Déploiement applicatif de production, approbation métier post-release ou sélection partielle des fonctionnalités d'une release.
- Gouvernance avancée d'organisation (facturation mutualisée, dashboard central multi-projets, console administrative SaaS).
- Campagnes iFixAi comportementales utilisant des LLM imposées à chaque PR applicative ; régression visuelle imposée à tous les dépôts.
- Support d'autres plateformes de forge que GitHub, et de moteurs agent autres que Pi et Codex en V1.

## Further Notes

- **État de la publication :** le dépôt GitHub cible sera **`Giskard-AI/epure`** (public). Cette spec est **le document de référence prêt à publier** sur l'issue tracker GitHub une fois le dépôt et `/setup-matt-pocock-skills` initialisés, avec le label `ready-for-agent` prescrit par `/to-spec`.
- **Décisions supplantées :** ADR-0003 (budgets LLM internes) a été remplacé par ADR-0012 ; ADR-0007 (relais et exécution centralisée) a été remplacé par ADR-0008. Leurs anciens choix ne sont pas des exigences V1.
- **Données et versionnement :** les documents de clarification et décisions acceptées doivent rester cohérents avec la branche et le SHA utilisés ; l'état machine d'orchestration réside dans `refs/epure/state/<issue-number>` (ADR-0024). Ne pas interpréter un statut d'ADR comme la preuve que le code correspondant est déployé.
- **Décisions d'implémentation tranchées en Ronde 19 & 20 (Q74–Q83) :** proxy/sidecar LLM local sur le runner + conteneur isolé sans secrets d'environnement (Q74, ADR-0023) ; rattrapage séquentiel en lot des commentaires via `last_processed_comment_id` (Q75, ADR-0024) ; stockage de l'état machine et du mandat signé dans `refs/epure/state/<issue-number>` + tableau de bord Markdown dans l'issue (Q76, ADR-0024) ; stack TypeScript strict sur Node.js 24 LTS avec Custom Actions pré-bundlées (Q77, ADR-0023) ; seuils par défaut de `.github/agents.yml` dont 60 min pour l'implémentation (Q78, ADR-0023) ; socle objectif Impeccable + règles de `DESIGN.md`/`.impeccable/surfaces/*.md` (Q79, ADR-0023) ; GitHub Repository Ruleset sur `main` et `refs/tags/v*` avec `Release App` en *Bypass Actor* (Q80, ADR-0025) ; identité publique `Giskard-AI/epure` et tags SemVer `vX.Y.Z` strictement immuables sans tag flottant `v1` (Q81–Q83, ADR-0025).
- **Risque de construction :** le composant le plus sensible est l'isolation des commandes d'agents vis-à-vis des clés LLM et des tokens de publication via le proxy LLM de sandbox (Q74). Le MVP ne peut se déclarer compatible avec Q9/Q31/Q74 si un agent peut exécuter des processus dans le même espace de secrets sans isolation réelle ; le comportement attendu est un refus sûr (*fail-closed*).
- **Références internes :** glossaire du domaine (`GLOSSARY.md`), registre Q1–Q83 (`docs/DECISIONS.md`), ADR-0001 à ADR-0025 (`docs/adr/`) ; licences et notices des versions exactes de Matt Pocock, Impeccable et iFixAi conservées au moment de l'intégration.
- **Suite du processus :** valider la frontière de test de `/to-spec` et le découpage en 38 tickets de `/to-tickets`, puis initialiser le dépôt GitHub `Giskard-AI/epure` et publier la spec et les tickets.
