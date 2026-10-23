# Registre de décisions de l'entretien

Ce registre complète les ADR et conserve les choix opérationnels déjà approuvés. Il ne remplace pas les spécifications futures.

## Ronde 1 — Q1 à Q3

- **Q1** : seuls les utilisateurs ayant permission GitHub `write` ou supérieure peuvent déclencher les agents et approuver les transitions humaines.
- **Q2** : l'approbation humaine d'un plan autorise l'exécution autonome de son graphe de tickets dans les limites prévues.
- **Q3** : une décision d'architecture peut être acceptée avant sa réalisation ; distinguer l'architecture cible de l'architecture effective.

## Ronde 2 — Q4 à Q8

- **Q4** : `main` stable, `dev` branche d'intégration, `feature/*` depuis `dev`, `task/*` depuis la fonctionnalité, promotion `dev` vers `main` séparée.
- **Q5** : les changements sensibles (workflows, permissions, secrets, migrations destructives) ne sont pas intégrés automatiquement, même vers une branche `feature/*`.
- **Q6** : implémentation des tickets en parallèle possible ; intégration sérialisée, avec validation du résultat combiné sur la dernière base.
- **Q7** : revalidation humaine des changements significatifs de périmètre, d'ADR ou de graphe de dépendances ; corrections locales autorisées.
- **Q8** : maximum trois tentatives de correction d'un ticket, puis `needs-human`, sans immobiliser les tickets indépendants.

## Ronde 3 — Q9 à Q13

- **Q9** : agents sans token GitHub en écriture, éditeur privilégié séparé à jeton GitHub App temporaire, tests non fiables isolés des secrets.
- **Q10** : la branche `feature/*` rattrape `dev` avant sa PR finale, pas à chaque commit ; contrôles relancés sur l'état combiné.
- **Q11** : une fonctionnalité incomplète peut ouvrir une PR en brouillon, mais tous les tickets obligatoires doivent être terminés ou dispensés par une personne autorisée avant l'intégration.
- **Q12** : Renovate ouvre les PR de dépendances vers `dev`. CI rouge : un agent peut consulter la documentation de migration et proposer des corrections. CI verte : pas d'agent de migration par défaut. PR vers `dev` : approbation humaine dans tous les cas.
- **Q13 (amendée par Q30)** : l’approbation initiale comprenait des budgets par ticket et fonctionnalité ; **leur dimension monétaire est abandonnée**. Restent la limite de concurrence, les timeouts et le maximum de trois tentatives par ticket (Q8). Voir ADR-0012.

## Ronde 4 — Q14 à Q18

- **Q14** : les ADR et autres documents approuvés sont d'abord intégrés à `dev`, pas à `main`. Les branches `feature/*` demeurent ancrées à une référence documentaire connue et sont contrôlées contre les décisions devenues incompatibles ; `main` ne reçoit les ADR qu'avec la release.
- **Q15** : la promotion `dev` → `main` est une opération **humaine et strictement fast-forward**, sans commit de merge ni réécriture des SHA. Une simple PR « Rebase and merge » de GitHub ne satisfait pas cette exigence. L'autorisation de mise à jour de `main` doit être réservée à l'identité de release et encadrée par des contrôles sur le SHA exact.
- **Q16** : reconstruction de l'état depuis GitHub après incident, publication idempotente par identifiants stables et réconciliation périodique ; pas de base externe au MVP.
- **Q17** : documentation dans le dépôt GitHub avec Git comme source de vérité ; Wiki et MkDocs sont des options non nécessaires au MVP.
- **Q18** : annuler un plan empêche de nouvelles exécutions et les intégrations automatiques ; interruption des jobs actifs dans la mesure du possible ; conservation intégrale de l'historique pour audit et reprise explicite.

## Ronde 5 — Q19 à Q22

- **Q19 accepté** : les hotfix urgents sont réalisés manuellement sur `main`, puis leurs commits sont réintégrés dans `dev` avant la prochaine release afin de préserver l'ascendance fast-forward.
- **Q20 accepté** : une release est l'intégralité de l'état validé de `dev` ; recours possible aux feature flags, pas de sélection de commits.
- **Q21 accepté, puis révisé** : `dev-automation` reste un dépôt distinct et versionné indépendamment, mais publie des Reusable Workflows (`workflow_call`) et des Custom Actions. Leur exécution a lieu sur les runners des dépôts appelants, avec leurs secrets et permissions. Le relais `repository_dispatch` vers une exécution centralisée est abandonné pour le parcours standard. Voir ADR-0008 (remplace ADR-0007).
- **Q22 accepté** : une GitHub Action `workflow_dispatch`, déclenchée par un humain autorisé, contrôle le SHA cible, les checks, l’ascendance, effectue `dev` → `main` strictement fast-forward puis crée tag et GitHub Release. Permissions et politique de tags à préciser avant implémentation.

## Interfaces de distribution — décision complémentaire

- **Interfaces publiques dès la V1 (accepté explicitement)** : exposer ET maintenir les Reusable Workflows ET les Custom Actions ; documenter les contrats (inputs, outputs, permissions, secrets, erreurs, versions), effectuer des tests de compatibilité, et versionner les changements incompatibles. Les actions unitaires n'offrent pas intrinsèquement les garanties de sécurité d'un workflow complet. Voir ADR-0008.


## Adoption et bootstrap — Q24

- **Q24 acceptée (option A)** : chaque utilisateur/organisation qui adopte `dev-automation` possède sa propre GitHub App et configure les permissions/secrets nécessaires dans ses dépôts. Aucune GitHub App commune au projet ni infrastructure centrale de distribution de jetons n’est prévue en V1. Une installation d’App peut couvrir plusieurs dépôts explicitement choisis ; cela ne signifie pas nécessairement une App par dépôt.
- **Skill d’installation confirmé** : distribuer avec `dev-automation` un skill pour configurer un dépôt consommateur, couvrant création/installation de l’App, configuration des workflows et des credentials, règles de branches et vérification initiale. Les modalités d’exécution du skill et son périmètre exact restent à préciser. Ne jamais exiger que l’utilisateur colle une clé privée dans un commentaire d’issue ou dans le chat.


## Ronde 7 — Q25 à Q28 (validées)

- **Q25** : chaque utilisateur/organisation installe **deux GitHub Apps distinctes** : Agent App (issues, branches, commits et PR) et Release App (promotion `dev` → `main`, tags, releases). Les tokens d’installation restent éphémères et réduits à la tâche. L'App de release est inaccessible aux agents de développement.
- **Q26** : le skill `setup-repo` installe et vérifie autant que possible les workflows, Custom Actions, GitHub Apps, secrets, protections de branches, Renovate, zizmor, conventions et limites **techniques** d’exécution. Il est **idempotent**, offre `--dry-run` et demande confirmation pour les opérations sensibles. Les dépenses LLM sont gérées exclusivement chez le fournisseur.
- **Q27** : premier bootstrap **local** avec Pi, Codex ou un agent local et `gh`, avant que les workflows IA soient fonctionnels ; les autorisations et manipulations de secrets requises restent sous contrôle de l'administrateur. L’exploitation courante passe ensuite par GitHub Issues et Actions.
- **Q28** : chaque dépôt consommateur possède une configuration `.github/agents.yml`, utilisant les valeurs par défaut de `dev-automation`. Les variables/secrets d'organisation peuvent être mutualisés ; la configuration locale ne peut pas alléger une politique de sécurité imposée par les composants partagés.

Voir [ADR-0010](adr/0010-bootstrap-et-configuration-des-depots-consommateurs.md).

## Ronde 8 — Q29 à Q32 (partiellement validées)

- **Q29 acceptée** : les dépôts consommateurs référencent les Reusable Workflows et Custom Actions de `dev-automation` par **SHA Git complet**, immuable. Renovate propose leurs mises à jour via PR ; `dev-automation` publie des versions SemVer. Les tags restent pratiques pour identifier les releases, mais ne remplacent pas le pinning de sécurité.
- **Q30 — clarifiée et validée** : aucune comptabilité ni plafond financier dans `dev-automation`. Facturation, crédits et limites monétaires restent chez les fournisseurs LLM ou liés à leurs clés API, si ces contrôles existent. Cette décision remplace les budgets monétaires de Q13 ; les garde-fous techniques subsistent. Voir ADR-0012.
- **Q31 acceptée** : exécution du code et des tests potentiellement non fiables dans un environnement isolé, inaccessible aux clés LLM et jetons GitHub privilégiés. Les actions unitaires ne garantissent pas seules cette isolation ; elle relève du workflow et du sandbox.
- **Q32 acceptée** : protéger `feature/*` et `dev` avec des exigences différentes. `task/* → feature/*` peut être mergé automatiquement après CI et review IA vertes, sous réserve des exceptions sensibles ; `feature/* → dev` nécessite validation humaine ; `dev → main` reste une promotion manuelle fast-forward via Action de release. Les mécanismes exacts de rulesets, règles requises et droits de bypass restent à vérifier pendant l’implémentation.

Voir [ADR-0011](adr/0011-versionnement-isolation-et-protection-des-branches.md).

## Ronde 9 — Q33 (validée)

- **Q33 acceptée** : en cas de `rate limit` transitoire, réessayer avec délai progressif et borne de tentatives ; si la clé est invalide, le crédit épuisé ou le quota bloquant, suspendre les exécutions dépendantes de l'API et signaler l'incident dans GitHub. Aucun basculement automatique vers une autre clé ou un autre fournisseur, afin de ne pas contourner les limites financières voulues. Les tentatives HTTP transitoires sont distinctes des trois tentatives de correction d'un ticket (Q8).

## Ronde 9 — Q34 à Q37 (validées)

- **Q34** : une conversation `grill-with-docs` est persistée sur `plan/*` ; les commentaires des issues sont l'interface humaine, tandis que glossaire, ADR proposés, synthèse des décisions et état de reprise sont versionnés sur la branche. La validation humaine précède l'intégration des documents sur `dev`.
- **Q35** : une seule exécution active par issue ; les commentaires concurrents sont consommés dans l'ordre avec protection contre les doublons, sans bloquer les issues indépendantes.
- **Q36** : une review IA est attachée au SHA de tête effectivement analysé (et au diff considéré) et doit être réévaluée après changement de contenu. En revanche, **un décalage de la branche cible ne force pas toujours une mise à jour/re-review** : un dépôt peut opter pour `strict` (par défaut) ou `relaxed`. En `relaxed`, si la PR reste sans conflit, que le code source et le diff approuvé restent identiques, et que les contrôles passent sur le **résultat combiné exact avec la cible courante**, un merge sur base avancée est permis. Aucune exception aux exigences natives de protection de branche, de review humaine ou de merge sérialisé. Les règles GitHub configurées peuvent imposer une re-review malgré l'option.
- **Q37** : toutes les opérations des agents sont traçables dans GitHub : rôle, modèle, version de `dev-automation`, lien du run ; ne pas divulguer les secrets, les clés ni les prompts sensibles.

Voir [ADR-0013](adr/0013-conversations-concurrence-et-reviews.md).

## Ouvert

- Définir précisément les valeurs par défaut des limites techniques (timeouts, concurrence, retries) lors de la spécification ; les montants financiers sont hors périmètre.

- Q22 détails opérationnels : dénomination/versionnement des tags, permissions et règle d'approbation du job, reprise après promotion partielle, politique de déploiement.


## Ronde 10 — Q38 à Q41 (validées)

- **Q38** : publier la review IA sous forme d'un GitHub Check `ai-review` lié au SHA analysé, complété de commentaires sur la PR ; verdict vert requis pour le merge automatique `task/* → feature/*`, sans substitution à une approbation humaine pour `feature/* → dev`. Requiert `checks: write` pour l'Agent App et un fournisseur de check identifié dans les protections GitHub.
- **Q39** : utiliser GitHub Merge Queue lorsque disponible et configurée ; sinon sérialiser et vérifier les intégrations par le contrôleur en validant le résultat combiné exact. Les politiques `strict` et `relaxed` de Q36 continuent de s'appliquer. Attention aux dépôts personnels publics où la Merge Queue peut ne pas être disponible.
- **Q40** : traiter seulement les nouveaux commentaires GitHub, pas les éditions d'anciens commentaires. Toute correction est un nouveau commentaire traçable.
- **Q41** : autoriser les corrections humaines sur `task/*`, mais réexécuter les contrôles CI et la review IA sur tout nouveau SHA avant un merge automatique.

Voir [ADR-0014](adr/0014-github-checks-merge-queue-et-collaboration-humaine.md).

## Ronde 11 — Q42 à Q45 (validées)

- **Q42** : `dev-automation` est public et open source, installable et utilisable par des tiers sans clés API, Apps GitHub ni services appartenant au mainteneur. Chaque consommateur apporte ses propres credentials. Voir ADR-0008.
- **Q43** : les skills repris, notamment ceux de Matt Pocock, sont figés sur une version/révision vérifiée, accompagnés des attributions/licences pertinentes ; les évolutions passent par des PR et tests avant adoption. Voir ADR-0008.
- **Q44, précision** : seules les personnes possédant la permission GitHub **effective `write` ou supérieure** sur le dépôt cible peuvent déclencher un agent ou une opération privilégiée ; être un contributeur historique, posséder une `author_association` particulière ou ouvrir une issue/PR ne donne pas ce droit. Les externes peuvent néanmoins ouvrir des issues/PR ordinaires, soumises à une CI non privilégiée. Q44 confirme Q1. Voir ADR-0004.
- **Q45** : les PR `feature/* → dev` requièrent une vraie approbation humaine via la review GitHub conforme à la protection de branche. Aucun check ou message d'agent ne la remplace. Voir ADR-0014.

## Ronde 12 — Q46 à Q47 (validées)

- **Q46** : l'approbation humaine initiale d'un plan peut déléguer l'enchaînement automatique des phases prévues, y compris via des événements émis par GitHub Actions ou une GitHub App. Chaque transition doit vérifier la provenance de l'événement, l'identité du plan, l'étendue de son autorisation, sa validité actuelle et les révisions Git pertinentes. Aucune extension de périmètre n'est autorisée implicitement.
- **Q47** : si un administrateur a activé `auto_migrate` dans la configuration approuvée du dépôt, une PR Renovate dont la CI échoue peut déclencher automatiquement un agent lisant les guides de migration et proposant une correction. La PR reste soumise à approbation humaine avant merge vers `dev`. Les secrets, checks et triggers externes restent soumis aux protections de Q5/Q9/Q31/Q44.

Voir [ADR-0015](adr/0015-declenchements-delegues-et-migrations-renovate.md).

## Ronde 13 — Q48 à Q51 (validées)

- **Q48** : autoriser un agent de migration seulement après vérification de la provenance effective de la PR Renovate (App/identité attendue, branche contrôlée, base `dev`) et de l’option `auto_migrate` approuvée ; les noms et labels seuls ne font pas autorité.
- **Q49** : classifier les échecs CI : compilation/tests de migration → correction potentielle ; panne d’infrastructure/réseau → retry borné, sans modifier le code ; échecs inexpliqués après au plus trois corrections → `needs-human`.
- **Q50** : releases **SemVer** ; une personne choisit la version dans une Action manuelle, qui vérifie SHA, checks et ascendance, réalise le fast-forward strict `dev` → `main`, crée un tag protégé puis une GitHub Release. Reprise idempotente en cas de publication partielle.
- **Q51** : deux moteurs dès la V1 : **Pi par défaut** et **Codex en alternative**, configurables par dépôt/phase, derrière un contrat d’exécution commun avec tests de compatibilité.

Voir [ADR-0016](adr/0016-fiabilite-renovate-releases-et-moteurs-agent.md).

## Ronde 14 — Q52 à Q55 (validées)

- **Q52** : ignorer les commentaires émis par les bots comme commandes humaines ; poursuivre les plans autorisés uniquement par événements techniques internes dont la provenance, la portée et l'état sont vérifiés. Prévenir les boucles et les événements dupliqués.
- **Q53** : reviewer indépendant en session et responsabilités de l'implementer, recevant spec, diff, SHA et résultats de tests, mais pas ses raisonnements internes ; aucune permission de modifier ou merger ; même modèle possible.
- **Q54** : une régression après merge sur `feature/*` bloque les intégrations automatiques suivantes pour cette feature ; créer une tâche corrective, respecter les limites de tentatives, escalader à un humain si nécessaire ; jamais de réécriture automatique d'historique partagé.
- **Q55** : le skill d'installation vérifie la présence d'une CI minimale pertinente. Tant qu'elle n'est pas en place et requise, désactiver le merge automatique `task/* → feature/*`, même si la review IA est verte.

Voir [ADR-0017](adr/0017-prevention-des-boucles-review-independante-et-reprises.md).


## Licence et intégrations tierces — Q56 à Q58 (validées)

- **Q56** : `dev-automation` est distribué sous **Apache-2.0** pour les composants originaux (Reusable Workflows, Custom Actions, skills originaux et bibliothèque). Les fichiers tiers conservent leurs licences et leurs notices de copyright : notamment MIT pour les skills repris de Matt Pocock, et Apache-2.0 pour les composants redistribués d'iFixAi et d'Impeccable. Maintenir un inventaire des composants tiers, leurs versions exactes et notices applicables. La licence du projet n'impose pas sa propre licence aux dépôts qui consomment ses workflows/actions. Voir ADR-0018.
- **Q57** : intégrer **Impeccable** dès la V1 comme skill d'assistance frontend et Custom Action de contrôle qualité CI, **optionnels et activables par dépôt**, sans obligation pour les dépôts purement backend. Versionner et épingler la dépendance, fournir un contrat d'entrée/sortie stable pour l'Action. Voir ADR-0019.
- **Q58** : intégrer **iFixAi** dès la V1 comme Custom Action d'audit des traces et autorisations, principalement pour le développement et la validation de `dev-automation`. Les tests comportementaux LLM restent optionnels et ne sont pas requis pour chaque PR applicative. Ne pas confondre audit a posteriori des traces et contrôle d'accès effectif au moment de l'action. Voir ADR-0019.

Les modalités exactes de déclenchement de ces contrôles, leur caractère bloquant, la conservation des traces et le schéma des événements restent des sujets ouverts de spécification / grilling.

## Ronde 15 — Q59 à Q61 (validées)

- **Q59 acceptée avec amendement** : Impeccable devient **obligatoire par défaut** sur les dépôts/projets frontend et peut être désactivé explicitement par configuration approuvée. Il n’est pas appliqué par défaut aux dépôts sans UI. Cela précise Q57 et modifie le mode initialement informatif proposé. Les sévérités bloquantes restent à définir.
- **Q60 acceptée** : les PR de `dev-automation` portant sur permissions, délégations et contrôle d’orchestration doivent exécuter l’audit déterministe iFixAi en CI ; les tests comportementaux LLM peuvent être lancés manuellement/périodiquement.
- **Q61 acceptée** : journal minimal structuré des autorisations et opérations, sans secrets ni publication systématique des conversations internes, avec rétention limitée configurable. Voir [ADR-0020](adr/0020-qualite-frontend-et-traces-d-audit.md).

## Ronde 16 — Q62 à Q65 (validées)

- **Q62** : pour les fonctionnalités frontend, `grill-with-docs` et Impeccable `shape` partagent la même issue GitHub et réutilisent les décisions existantes avant finalisation des spécifications et tickets.
- **Q63** : prototype léger préalable si nécessaire pour les changements d'interface importants ; branche `prototype/*`, données fictives, captures et prévisualisation rattachées à l'issue ; jamais de merge automatique du prototype vers `dev`.
- **Q64** : `PRODUCT.md`, `DESIGN.md`, `.impeccable/surfaces/*.md`, `docs/specs/*.md`, et `docs/adr/*.md` versionnés dans Git. Les modifications en cours restent sur `plan/*` jusqu'à approbation puis intégration sur `dev`.
- **Q65** : Impeccable requis par défaut pour frontend et **bloquant pour nouvelles violations de règles identifiées comme obligatoires** ; constats esthétiques subjectifs non bloquants et exceptions explicites. L'opt-out de dépôt reste possible conformément à Q59.

Voir [ADR-0021](adr/0021-conception-ux-ui-prototypes-et-controles-impeccable.md).

## Ronde 17 — Q66 à Q69 (validées avec amendement)

- **Q66** : captures et artifacts GitHub Actions sont la solution universelle ; les previews HTML/CSS/JS GitHub Pages sont facultatives et nécessitent une activation explicite (Q70), et un site de preview déjà disponible peut également être réutilisé. Aucun hébergeur externe imposé. La publication multi-prototypes requiert gestion explicite des collisions et nettoyage ; aucune donnée sensible sur un site public.
- **Q67 refusée** : ne **pas réutiliser le code source des prototypes exploratoires** dans l'implémentation. Les agents repartent du code applicatif approuvé en utilisant les exigences, captures et comportements validés comme référence. Aucun cherry-pick ou merge automatique depuis `prototype/*`.
- **Q68 acceptée** : tests de régression visuelle en CI optionnels en V1, références visuelles versionnées et changées sous review ; indépendants du contrôle Impeccable obligatoire par défaut.
- **Q69 acceptée** (la seconde mention « Q68 oui » a été interprétée comme « Q69 oui ») : présentation de la spec et du graphe de tickets **avant** l'approbation humaine autorisant leur implémentation. Parcours `Grill → UX/Design → Prototype éventuel → Spec → Tickets → Approval → Implement`.

Voir [ADR-0022](adr/0022-prototypes-previews-et-validation-du-plan.md).

## Confirmation complémentaire de Q66 — trois modes de preview (validée)

- L'utilisateur valide explicitement les **trois modes complémentaires** de prévisualisation : (1) captures et artifacts GitHub Actions, (2) publication statique GitHub Pages si configurée, (3) recours à l'hébergement de preview déjà présent dans le dépôt consommateur. Pas de dépendance à un hébergeur externe imposé.
- Ces trois modes ont été confirmés ; activation Pages, rétention et isolation ont ensuite été décidées en Q70, Q71 et Q73. Q67 (prototype non réutilisable) reste inchangée.

## Questions opérationnelles à détailler en spécification — prototypage

- Choisir une origine/site de preview distinct de la production lorsque GitHub Pages est activé ; définir le repli vers les artifacts si l'isolation ne peut être garantie.
- Détailler les opérations de nettoyage et les accès concurrents aux previews, dans le respect de Q71.
- Le déclenchement d'un prototype suit le parcours `ask-matt`/`grilling` et Impeccable `shape` (Q72), sans seuil arbitraire à inventer.


## Ronde 18 — Q70 à Q73 (validées)

- **Q70 (acceptée)** : GitHub Pages est **désactivé par défaut**. Le skill local `setup-repo` peut proposer de l’activer, mais seulement avec un accord explicite de l’utilisateur. Les artifacts et captures GitHub Actions restent disponibles sans publication. Si un site Pages existant est employé en production, préserver une origine isolée pour les previews conformément à Q73.
- **Q71 (acceptée)** : supprimer automatiquement les previews hébergées après 14 jours par défaut, durée configurable par dépôt ; préserver séparément les documents de décision utiles.
- **Q72 (acceptée avec modification)** : utiliser le workflow natif de Matt Pocock et d'Impeccable, sans seuil de taille créé par `dev-automation`. Le détour `/prototype` se fait quand une question UX, de design ou de modèle d'état ne peut être résolue par conversation ; `grill-with-docs`/`ask-matt` propose le détour, `handoff` conserve la question et la conclusion ; Impeccable `shape` cadre les questions d'interface. Pas de prototype obligatoire sur chaque fonctionnalité. Q67 reste inchangée : code exploratoire non réutilisé.
- **Q73 (acceptée)** : publication de previews seulement si isolées du site de production, sans secrets ni données personnelles, et après validation par le publisher ; sinon refuser la publication. Un sous-chemin d'un même site n'est pas une séparation d'origine navigateur.

Voir [ADR-0022](adr/0022-prototypes-previews-et-validation-du-plan.md).

## Ronde 19 & 20 — Q74 à Q83 (validées)

- **Q74 (validée — Option A1)** : isolation de la clé API LLM et des tokens via un proxy/sidecar local sur le runner détenant la clé en mémoire, tandis que l'agent et les sous-processus de test/build du dépôt consommateur s'exécutent dans un conteneur isolé sans secret dans leurs variables d'environnement (échec fermé si l'isolation est indisponible).
- **Q75 (validée — Option A)** : un seul run actif par issue (`concurrency: issue-<N>` sans annulation du run en cours), et à son démarrage le job lit et traite séquentiellement en lot tous les nouveaux commentaires humains postés depuis le dernier passage de l'agent (`last_processed_comment_id`), évitant toute perte lorsque GitHub Actions fusionne la file d'attente au-delà de 2 événements.
- **Q76 (validée — Option 4 hybride)** : les livrables documentaires (`GLOSSARY.md`, `docs/adr/`, `docs/specs/`, `DESIGN.md`) vivent sur `plan/<issue>` puis sont mergés dans `dev`, tandis que l'état machine d'orchestration (`last_processed_comment_id`, mandat signé `spec_sha`, `approved_by`, statut `active|cancelled`, compteurs d'essais) est stocké dans une **référence Git dédiée hors branches** (`refs/epure/state/<issue-number>`) avec *compare-and-swap* atomique Git, doublée d'un tableau de bord Markdown lisible mis à jour en haut de l'issue GitHub (zéro pollution de `dev` et `main`).
- **Q77 (validée)** : implémentation d'`EPURE` en **TypeScript strict sur Node.js 24 LTS**, avec Custom Actions pré-bundlées (sans `npm install` requis à l'exécution chez le consommateur), CLI locale pour `setup-repo`, et Composite Actions uniquement pour l'invocation des binaires externes (`pi`, `codex`, `zizmor`).
- **Q78 (validée avec amendement)** : valeurs par défaut dans `.github/agents.yml` :
  - `max_code_fix_attempts`: **3**
  - `max_transient_api_retries`: **4** (backoff exponentiel 5s → 15s → 45s → 120s)
  - `job_timeout_minutes`: **60 minutes (1h)** pour l'implémentation (et 30 minutes pour les phases courtes de review/triage)
  - `max_concurrent_tasks_per_feature`: **3**
  - `trace_retention_days`: **30 jours** (et **14 jours** pour les previews hébergées)
- **Q79 (validée avec amendement)** : les violations Impeccable bloquantes par défaut sur les PR frontend couvrent : (1) le socle objectif par défaut (accessibilité vérifiable WCAG/ARIA/contraste/clavier, cassures de layout/overflow responsive, états obligatoires loading/error/empty manquants), **plus** (2) toutes les règles et tokens ajoutés dans `DESIGN.md` et `.impeccable/surfaces/*.md` au fur et à mesure de leur définition. Les remarques purement esthétiques/subjectives restent informatives.
- **Q80 (validée — Option A)** : `setup-repo` configure un **GitHub Repository Ruleset** sur `main` et `refs/tags/v*` avec la seule `Release App` en *Bypass Actor*, associé à un GitHub Environment `release` pour le workflow manuel de promotion fast-forward `dev → main`.
- **Q81 (validée)** : le dépôt public sera hébergé dans l'organisation **`Giskard-AI`** sous le nom **`EPURE`** (*L'épure est le dessin d'architecture à l'échelle qui sert de plan d'exécution*), avec dans le `README.md` le rétro-acronyme anglais (*Engineered Planning, Unified Review & Execution*) et français (*Élaboration de Plans, Usinage, Revue et Exécution*).
- **Q82 (validée)** : slug GitHub en minuscules **`Giskard-AI/epure`** pour les appels d'Actions et Workflows (`uses: Giskard-AI/epure/...`), nom d'affichage **`EPURE`**, et duo d'acronymes retenu dans le `README.md` (**EN** : *Engineered Planning, Unified Review & Execution* / **FR** : *Élaboration de Plans, Usinage, Revue et Exécution*).
- **Q83 (validée — Option A)** : uniquement des tags SemVer `vMAJOR.MINOR.PATCH` strictement immuables protégés par Ruleset (aucun tag flottant mobile `v1`) ; les dépôts consommateurs épinglent le SHA complet (`uses: Giskard-AI/epure/.../@<sha> # vX.Y.Z`) et Renovate met à jour le SHA ainsi que le commentaire de version.

Voir [ADR-0023](adr/0023-sandbox-proxy-llm-et-stack-typescript.md), [ADR-0024](adr/0024-etat-orchestration-git-refs-et-batch-comments.md) et [ADR-0025](adr/0025-depot-public-epure-rulesets-et-tags-immuables.md).

