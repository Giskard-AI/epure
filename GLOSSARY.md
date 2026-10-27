# Orchestration du développement semi-automatisé

Vocabulaire métier du pilotage de développement par issues, décisions, branches, validations et agents.

## Demandes et décisions

**Issue de pilotage** : demande principale qui rassemble le dialogue de clarification, les décisions et le périmètre d'une fonctionnalité.
_Éviter_ : ticket d'implémentation, pull request.

**Plan approuvé** : périmètre, critères d'acceptation et graphe de tâches autorisés par un humain pour exécution autonome, sous conditions définies.
_Éviter_ : brouillon, simple proposition.

**Ticket d'implémentation** : unité de travail issue d'un plan approuvé, réalisable et vérifiable séparément.
_Éviter_ : issue de pilotage, décision architecturale.

**Dépendance bloquante** : relation empêchant un ticket de devenir exécutable tant qu'un autre n'est pas résolu conformément au plan.
_Éviter_ : lien de parenté, simple référence.

**Changement de périmètre** : modification significative des exigences, des choix architecturaux ou des dépendances au-delà de l'autorisation du plan approuvé.
_Éviter_ : correction technique interne au périmètre.

**Architecture cible** : ensemble des décisions architecturales acceptées, qu'elles soient déjà réalisées ou non.
_Éviter_ : architecture effective.

**Architecture effective** : organisation et comportement réellement présents dans une version déterminée du code.
_Éviter_ : architecture cible.

## Acteurs et contrôles

**Contributeur autorisé** : utilisateur disposant de la permission GitHub **effective `write` ou supérieure** sur le dépôt cible, vérifiée au moment de la demande ou de la transition privilégiée. Seule cette permission permet le déclenchement des agents.
_Éviter_ : `author_association`, contributeur historique ou simple ouverture d'issue/PR comme preuve de droit.

**Contribution externe** : issue ou PR ordinaire soumise par une personne sans permission `write` ; acceptée comme contribution publique mais jamais comme autorisation d'exécuter des agents ou du code avec secrets privilégiés.
_Éviter_ : déclencheur LLM, instruction d'administration.

**Revue indépendante** : évaluation d'un changement par un agent distinct de celui qui l'a produit, à partir de la spécification et du code soumis.
_Éviter_ : autovalidation de l'agent d'implémentation.

**Validation automatisée** : ensemble des contrôles requis pour déclarer une contribution éligible à une intégration sans approbation humaine individuelle.
_Éviter_ : validation humaine d'intégration.

**Validation humaine d'intégration** : approbation par une personne autorisée de l'intégration d'une fonctionnalité complète dans la branche de développement partagée.
_Éviter_ : revue automatisée d'un ticket.

**Exception sensible** : changement dont le niveau de risque exclut l'intégration automatique, même si les contrôles automatisés sont concluants.
_Éviter_ : ticket ordinaire.

**Escalade humaine** : passage d'un ticket ou d'un plan à un état requérant une décision humaine avant reprise.
_Éviter_ : échec définitif, annulation.

## Unités d'intégration

**Branche de fonctionnalité** : branche regroupant les changements de tous les tickets d'une demande approuvée avant l'intégration humaine à la branche de développement partagée.
_Éviter_ : branche de ticket, branche stable.

**Branche de ticket** : branche isolant le changement d'un ticket jusqu'à son intégration à la branche de fonctionnalité.
_Éviter_ : branche de fonctionnalité.

**Intégration de ticket** : admission d'une contribution dans la branche de fonctionnalité après réussite des contrôles automatisés et absence d'exception sensible.
_Éviter_ : intégration de fonctionnalité.

**Intégration de fonctionnalité** : admission d'une branche de fonctionnalité dans la branche de développement partagée après validation humaine.
_Éviter_ : intégration de ticket, release.

**Intégration sérialisée** : traitement ordonné des intégrations de tickets dans une même branche de fonctionnalité, même lorsque leur développement a lieu en parallèle.
_Éviter_ : développement séquentiel.

**Release** : promotion d'un état validé du développement partagé vers la version stable.
_Éviter_ : intégration de ticket, intégration de fonctionnalité.

## Sécurité et autonomie

**Exécuteur d'agent** : composant qui réalise une phase de travail autonome sans disposer des droits de publication privilégiés sur GitHub.
_Éviter_ : éditeur GitHub, contrôleur de permissions.

**Éditeur privilégié** : composant qui applique à GitHub des opérations préalablement autorisées et validées, à l'aide d'une identité technique temporaire.
_Éviter_ : agent d'implémentation, agent de planification.

**Gestion financière externe du LLM** : facturation, crédits, éventuels plafonds financiers et quotas de dépense gérés par le fournisseur LLM ou la clé API, sans comptabilité ni budget monétaire dans `dev-automation`.
_Éviter_ : budget de ticket, budget de fonctionnalité, coût calculé en CI.

**Garde-fou opérationnel d'agent** : limite technique d'exécution appliquée par `dev-automation` (nombre de tentatives, concurrence, timeout), sans prétendre garantir un coût monétaire.
_Éviter_ : plafond de dépense LLM, limite de facturation fournisseur.

**Agent de migration** : agent chargé de proposer les changements nécessaires à la compatibilité d'une mise à jour de dépendance, sans décider lui-même de sa promotion en développement partagé.
_Éviter_ : gestionnaire de dépendances, bot de publication.

**PR de visibilité** : pull request ouverte en brouillon pour rendre visible une fonctionnalité encore incomplète, sans autoriser son intégration.
_Éviter_ : PR prête à intégrer.

## Documentation et livraison

**Contrôleur de dispatch** : logique versionnée dans `dev-automation` et exécutée par un workflow partagé dans le dépôt appelant, qui authentifie l’auteur de l’événement, contrôle les transitions et délègue aux exécuteurs autorisés (Q21 révisée).
_Éviter_ : code expérimental de `dev`, agent qui exécute des tests non fiables.

**Release à déclenchement humain** : workflow `workflow_dispatch` lancé par un humain autorisé qui vérifie une révision figée de `dev`, avance `main` uniquement par fast-forward, puis crée le tag et la GitHub Release sur cette même révision. Les actions Git restent automatisées ; leur lancement ne l'est pas.
_Éviter_ : push Git manuel obligatoire, promotion automatique au merge dans `dev`.

**Hotfix stable** : correctif urgent préparé et validé manuellement pour `main`, puis réintégré dans `dev` avant la prochaine promotion fast-forward.
_Éviter_ : release sélective de `dev`, réécriture forcée des branches.

**Release intégrale** : promotion de l'intégralité du SHA validé de `dev`, sans sélectionner certains commits ou tickets ; si nécessaire, le comportement non publiable demeure désactivé par des feature flags.
_Éviter_ : cherry-pick sélectif d'une feature au moment de la release.


**ADR approuvé** : décision architecturale acceptée par un humain et intégrée d'abord à `dev`, puis incluse dans `main` lors d'une release.
_Éviter_ : architecture effective, décision seulement proposée.

**Référence documentaire** : commit Git immuable contenant les ADR, glossaire et spécification auxquels un ticket est tenu de se conformer.
_Éviter_ : dernière version implicite ou non qualifiée.

**Promotion fast-forward** : déplacement du pointeur de `main` sur un commit descendant de son SHA actuel, sans commit de fusion ou réécriture d'historique.
_Éviter_ : action GitHub « Rebase and merge », qui recrée les commits.

**Révision de release** : SHA précis de `dev` sur lequel portent l'approbation humaine, les contrôles et l'avancement de `main`.
_Éviter_ : nom mouvant de branche sans contrôle de SHA.

**Réconciliation** : relecture déterministe des objets GitHub et correction des états incomplets ou des opérations interrompues, de façon idempotente.
_Éviter_ : nouvelle exécution aveugle d'une opération déjà produite.

**Plan annulé** : plan désactivé pour toute nouvelle exécution et intégration automatique, sans destruction de ses traces ni branches existantes.
_Éviter_ : plan terminé, plan suspendu après échec.

**Workflow appelant** : workflow du dépôt applicatif qui reçoit un événement (par exemple `issue_comment`) et invoque un Reusable Workflow versionné de `dev-automation` via `workflow_call` ; les jobs s’exécutent pour le dépôt appelant.
_Éviter_ : relais `repository_dispatch` obligatoire, exécuteur central implicite.

**Dépôt d’automatisation (`EPURE`)** : dépôt public `Giskard-AI/epure` (*Engineered Planning, Unified Review & Execution* / *Élaboration de Plans, Usinage, Revue et Exécution*), indépendant des releases applicatives, qui distribue les workflows réutilisables, Custom Actions, politiques et skills (Q21 révisée, Q81, ADR-0008).
_Éviter_ : service hébergé central qui consomme les secrets et quotas des utilisateurs.

**Reusable Workflow** : workflow GitHub exposé via `workflow_call`, déclarant une orchestration multi-jobs, les préconditions, permissions et secrets attendus ; exécution sur les ressources du dépôt appelant.
_Éviter_ : Custom Action mono-étape, exécution centralisée.

**Custom Action** : composant GitHub Actions autonome référencé par son `action.yml`, exécuté comme étape d’un job appelant et héritant de son contexte de sécurité.
_Éviter_ : frontière d’isolation entre agents et secrets.

**Interface publique V1** : contrat versionné et documenté des Reusable Workflows et des Custom Actions ; les modifications incompatibles requièrent une nouvelle version majeure.
_Éviter_ : bibliothèque interne sans garantie de compatibilité.

## Mise en service d’un dépôt consommateur

**GitHub App du consommateur** : application enregistrée et détenue par l’utilisateur ou l’organisation qui adopte `dev-automation`, installée sur les seuls dépôts sélectionnés et utilisée pour émettre des jetons d’installation temporaires. Elle n’est pas administrée par le mainteneur de `dev-automation`.
_Éviter_ : GitHub App partagée du mainteneur, jeton personnel permanent.

**Skill de configuration d’un dépôt** : procédure interactive et versionnée, distribuée par `dev-automation`, qui aide à vérifier les prérequis, enregistrer/installer la GitHub App du consommateur, configurer les variables et secrets locaux, installer workflows et politiques, puis vérifier l’installation. Les opérations sensibles nécessitent l’action ou l’accord de l’administrateur concerné.
_Éviter_ : service d’installation hébergé, émission automatique de secrets sans contrôle du propriétaire.

**Agent App** : GitHub App possédée par le consommateur, réservée aux opérations de développement (issues, branches, commits, PR), sans autorité de promotion d'une release.
_Éviter_ : Release App, token d'administration générale.

**Release App** : GitHub App distincte réservée au workflow humain de promotion `dev` → `main`, à la création de tags et de releases.
_Éviter_ : Agent App, jeton de développement.

**Bootstrap local** : première installation de `dev-automation` dans un dépôt consommateur par un skill exécuté localement, avant que la CI agents ne soit opérationnelle.
_Éviter_ : installation déclenchée depuis une issue non authentifiée.

**Configuration d'agents par dépôt** : fichier `.github/agents.yml` déclarant les choix locaux autorisés (harness, modèles, limites), dont aucune valeur ne peut abaisser les restrictions du workflow partagé.
_Éviter_ : secrets en clair, dérogation de sécurité locale.

**Installation idempotente** : procédure pouvant être rejouée sans duplication ni écrasement intempestif, précédée d'une inspection et proposant un mode `--dry-run`.
_Éviter_ : réinitialisation aveugle de la configuration.


## Distribution et garde-fous (ronde 8)

**Référence immuable de workflow/action** : SHA Git complet du dépôt `dev-automation` utilisé pour charger un workflow ou une Custom Action, dont la mise à jour est proposée par une PR Renovate.
_Éviter_ : tag mutable `v1` présenté comme immuable.

**Sandbox de code non fiable** : environnement qui empêche des processus lancés sur du code potentiellement hostile de lire les credentials et secrets des agents, publisher ou release.
_Éviter_ : simple masquage de logs, action composite considérée comme frontière de sécurité.

**Merge automatique conditionnel** : merge d'une PR `task/* → feature/*` après vérification de la CI, de la review IA, de la base d'intégration courante et de l'absence de changement sensible.
_Éviter_ : intégration directe sur `dev`, validation sur une base obsolète.

**Contrôle financier fournisseur** : limite financière qui peut être fournie par le prestataire LLM (compte, organisation, clé API). Elle n'est pas garantie par `dev-automation` et peut être indisponible selon le prestataire.
_Éviter_ : garantie de plafond global par le workflow, compteur financier GitHub.

**Échec transitoire du fournisseur LLM** : indisponibilité ou coupure temporaire d'une API (`5xx`, `408`, timeout/coupure réseau) permettant une reprise bornée avec backoff (`max_transient_api_retries`, comptabilisé par requête HTTP unitaire et non cumulé sur l'ensemble d'une boucle d'outils). Les répétitions réseau/API ne consomment pas le quota de trois corrections de code d'un ticket.
_Éviter_ : recommencer sans borne, masquer une panne persistante, mutualiser un unique compteur de reprises sur 20 tours d'outils.

**Temporisation de limite de débit LLM (`429`)** : attente automatique lors d'une limitation temporaire de débit (`HTTP 429` hors épuisement de quota/facturation) respectant l'indication `Retry-After` du fournisseur (ou un délai progressif par défaut plafonné à 300 secondes, jusqu'à 10 attentes par requête HTTP), suivie d'une relance **sans consommer** le quota `max_transient_api_retries` ni le quota de corrections de code du ticket.
_Éviter_ : décompter une pause de rate-limit `429` comme un échec serveur ou attendre indéfiniment sans plafond de sécurité.

**Blocage fournisseur LLM** : problème de clé, de crédits ou de quota empêchant la poursuite des tâches dépendantes ; signalement GitHub et suspension sans changement automatique de clé ou de fournisseur.
_Éviter_ : fallback automatique contournant les plafonds définis par l'utilisateur.

**Reprise après suspension (`suspended -> active`)** : réactivation idempotente d'une issue de pilotage ou d'un ticket en état `suspended` (`needs-human`) lorsqu'un contributeur autorisé (`write` ou supérieur) publie une réponse ou relance la commande de phase correspondante, retirant le label `needs-human`, restaurant le statut `active` tout en conservant la phase courante (`grilling`, `spec`, `tickets`, `implementation`) et reprenant au dernier jalon validé.
_Éviter_ : bloquer définitivement une issue suspendue après une panne API temporaire ou écraser la phase d'orchestration lors de la suspension.

## Orchestration des conversations et des reviews (ronde 9)

**État de conversation versionné** : documents et décisions intermédiaires d'un entretien conservés dans `plan/*`, distincts des commentaires GitHub qui servent d'interface humaine.
_Éviter_ : dépendance à la mémoire du runner, relecture intégrale systématique des commentaires.

**Exécution ordonnée par issue** : protocole garantissant une exécution active au maximum pour chaque issue et le traitement/dédoublonnage des commentaires suivants.
_Éviter_ : jobs concurrents publiant des décisions contradictoires sur une même issue.

**Review IA liée au SHA** : verdict portant sur une version exacte de la branche source et le diff réellement examiné ; tout changement du code revu invalide ce verdict.
_Éviter_ : review positive réutilisée après modification du code.

**Politique de base obsolète (`strict` / `relaxed`)** : politique par dépôt. `strict` impose une base actuelle ; `relaxed` tolère une source en retard sans conflit si le diff approuvé est inchangé et la CI réussit sur son intégration à la dernière cible.
_Éviter_ : « pas de conflit Git » considéré seul comme test d'intégration.

**Résultat combiné** : arbre Git résultant de l'intégration d'une PR à la révision courante de sa branche cible, utilisé par les tests d'intégration avant fusion.
_Éviter_ : seuls tests de la branche source avec une cible antérieure.

**Traçabilité d'exécution d'agent** : métadonnées GitHub associant rôle d'agent, modèle, révision de `dev-automation` et lien du run aux opérations effectuées.
_Éviter_ : publication de secrets ou de données sensibles des prompts.

## Validation GitHub et interventions humaines (ronde 10)

**GitHub Check `ai-review`** : résultat de review IA publié par l'Agent App sur le SHA analysé, pouvant devenir un contrôle obligatoire de protection de branche. Son producteur autorisé fait partie de sa validité.
_Éviter_ : commentaire « LGTM » comme preuve de review, check homonyme émis par un autre acteur.

**Merge Queue native** : mécanisme GitHub, lorsqu'il est disponible, qui met en file les PR et contrôle leur intégration avec les changements précédents. Sinon, le contrôleur réalise une sérialisation et une validation équivalentes à son niveau sans contourner les règles GitHub.
_Éviter_ : supposer la disponibilité sur chaque dépôt public personnel.

**Correction par nouveau commentaire** : modification d'une décision de planning au moyen d'un commentaire ultérieur, plutôt que par édition rétroactive d'une réponse déjà traitée.
_Éviter_ : réinterprétation silencieuse des décisions archivées.

**Intervention humaine sur une branche de ticket** : commit produit par un contributeur autorisé sur `task/*`, autorisé mais invalidant les contrôles anciens liés à un SHA ou à un diff obsolètes.
_Éviter_ : traiter une ancienne review positive comme valable après une correction humaine.

## Déclenchements délégués et maintenance des dépendances (ronde 12)

**Autorisation déléguée d'un plan** : permission humaine enregistrée pour un ensemble précis d'opérations et de tickets approuvés ; les événements internes peuvent poursuivre ce plan sans devenir de nouvelles approbations. Chaque opération vérifie l'autorisation et l'état courant avant exécution.
_Éviter_ : considérer n'importe quel événement GitHub App ou workflow comme un mandat général.

**Migration Renovate automatique (`auto_migrate`)** : option administrateur permettant à un agent de proposer des correctifs sur une PR Renovate dont la CI échoue, en consultant les guides de migration ; n'autorise pas à merger vers `dev` sans approbation humaine.
_Éviter_ : exécuter avec secrets le code d'une PR non vérifiée, utiliser une PR arbitraire comme déclencheur.

## Migrations, releases et moteurs d’agent (ronde 13)

**Provenance Renovate vérifiée** : identité de l’application et origine de la PR reconnues par GitHub, plus correspondance avec le dépôt et la branche cible attendus ; condition nécessaire à `auto_migrate`.
_Éviter_ : inférence depuis un titre, label ou nom de branche.

**Diagnostic d’échec CI** : détermination de la cause probable (régression de code, rupture de compatibilité, infrastructure, cause incertaine) avant toute tentative de modification.
_Éviter_ : faire modifier le code par un agent à chaque job rouge.

**Release SemVer** : promotion humaine fast-forward de `dev` vers `main`, suivie de la création contrôlée d’un tag `vMAJOR.MINOR.PATCH` et d’une GitHub Release sur le même SHA.
_Éviter_ : tag déplaçable librement, release déclenchée directement par un agent, `rebase and merge` appelé fast-forward.

**Adaptateur de moteur d’agent** : composant implémentant une interface stable de pilotage et de résultats pour un moteur d’agent comme Pi ou Codex, indépendamment de sa CLI.
_Éviter_ : exposer dans tout l’orchestrateur les formats propriétaires d’un moteur donné.

## Garde-fous de fin d'entretien (ronde 14)

**Événement interne autorisé** : événement technique produit dans la poursuite d'un plan préalablement approuvé et vérifié par l'orchestrateur ; il n'accorde aucune permission supplémentaire.
_Éviter_ : interpréter une réponse de bot comme une commande d'un humain.

**Review IA indépendante** : évaluation d'une révision par une session distincte de l'agent d'implémentation, avec spec, diff et tests, sans accès aux raisonnements internes de ce dernier ni pouvoir de merge.
_Éviter_ : autoprobation par l'implementer, réutilisation d'une review pour un nouveau SHA.

**Blocage de fonctionnalité après régression** : suspension persistante des merges automatiques vers une branche `feature/*` lorsqu'une intégration y provoque une régression constatée ; reprise après correction et nouveaux contrôles satisfaisants.
_Éviter_ : force-push de réparation, poursuite aveugle des autres merges.

**CI minimale requise** : ensemble de checks adaptés au dépôt, réellement configurés comme obligatoires avant tout merge automatique de ticket ; l'existence d'un workflow ou d'un check IA seul n'est pas suffisante.
_Éviter_ : intégrer automatiquement sur la seule base d'une review IA verte.


## Licence et évaluation des agents (Q56–Q58)

**Licence du projet (Apache-2.0)** : licence choisie pour le code original de `dev-automation`, permettant la réutilisation commerciale et privée avec obligations de préservation des notices et licence explicite sur les brevets couverts.
_Éviter_ : prétendre relicencier en bloc des fichiers tiers ou imposer cette licence aux dépôts consommateurs.

**Attribution des composants tiers** : conservation des textes de licence, avis de copyright et `NOTICE` applicables aux contenus effectivement copiés ou redistribués, avec référence à leur provenance et révision.
_Éviter_ : assimiler une dépendance installée à une copie embarquée, ou supprimer les mentions MIT/Apache d'origine.

**Impeccable (intégration optionnelle)** : ensemble de skills et contrôles spécialisés frontend proposé via une Custom Action publique et un skill d'assistance ; activable par dépôt selon sa technologie.
_Éviter_ : déclencher systématiquement des contrôles UI sur des dépôts purement backend, ou leur accorder des permissions privilégiées sans nécessité.

**iFixAi (intégration optionnelle)** : outil d'audit des événements/trajectoires et de tests comportementaux, utilisé prioritairement pour évaluer la sécurité de `dev-automation` ; l'audit des traces complète sans remplacer l'application de la politique d'autorisation.
_Éviter_ : faire du score d'audit un substitut à la séparation des privilèges ou imposer un appel LLM sur chaque PR applicative.

## Qualité visuelle et audits (Q59–Q61)

**Check de design obligatoire par défaut** : check CI Impeccable installé comme contrôle requis des PR frontend et désactivable par choix explicite du dépôt. Le seuil des constats bloquants reste à spécifier.
_Éviter_ : audit visuel systématique de dépôts sans interface, « informatif » par défaut.

**Trajectoire d'audit minimisée** : suite structurée d'événements, permissions et transitions, limitée aux métadonnées vérifiables nécessaires à l'évaluation d'iFixAi, sans secrets ni logs internes complets.
_Éviter_ : journal de prompts non filtré, stockage de credentials.

## Conception frontend intégrée (Q62–Q65)

**Entretien UX/UI unifié** : extension de l'issue de pilotage après `grill-with-docs` utilisant le cadrage Impeccable `shape`, avec réutilisation des décisions existantes.
_Éviter_ : ouvrir une deuxième conversation de conception déconnectée du plan approuvé.

**Prototype exploratoire** : représentation légère d'une interaction ou interface importante, produite avant approbation sur `prototype/*` avec données fictives ; captures et informations de prévisualisation liées à l'issue.
_Éviter_ : assimiler le prototype à du code prêt à merger automatiquement sur `dev`.

**Contexte produit (`PRODUCT.md`)** : document versionné décrivant utilisateurs, besoins et contraintes produit, distinct des spécifications d'une fonctionnalité.
_Éviter_ : confondre contexte produit durable et exigences d'un ticket.

**Système de design (`DESIGN.md`)** : document versionné de conventions et choix UX/UI, distinct des décisions propres à un écran (`.impeccable/surfaces/*.md`).
_Éviter_ : règles visuelles contradictoires dispersées dans les prompts d'agents.

**Violation de design bloquante** : problème **nouveau** qui correspond soit aux règles bloquantes par défaut d'Impeccable (accessibilité vérifiable, cassures de layout/overflow, non-respect des tokens définis, états d'interaction obligatoires manquants), soit à une règle supplémentaire ajoutée dans `DESIGN.md` ou `.impeccable/surfaces/*.md`, identifié par le check CI et empêchant le merge tant qu'il n'est pas corrigé ou explicitement exempté.
_Éviter_ : bloquer une PR sur une préférence esthétique subjective ou sur l'ensemble du passif visuel non modifié.

## Prévisualisation et transfert design → implémentation (Q66–Q69)

**Artifact de prévisualisation** : capture, rapport ou fichier HTML produit par une CI et accessible depuis la page du run ou ses artifacts, sans hébergement externe requis.
_Éviter_ : assimiler des fichiers HTML complexes à un site navigable servi par un hébergeur.

**Preview statique GitHub Pages** : publication facultative de prototypes HTML/CSS/JS fictifs et non sensibles accessibles par URL ; une prévisualisation isolée par issue nécessite une stratégie de répertoires/versionnement et de nettoyage.
_Éviter_ : supposer une preview native par PR ou y intégrer des secrets et des données privées.

**Prototype non réutilisable** : code exploratoire produit pour valider un comportement ou une direction UX, sans transfert direct dans le code applicatif final. Seuls les choix design, critères d'acceptation et actifs de référence constituent des entrées pour l'implémentation.
_Éviter_ : cherry-pick, copie ou merge automatique du code de `prototype/*`.

**Approbation du graphe de tickets** : autorisation humaine donnée après production de la spec et des tickets dépendants ; elle délimite le périmètre exécutable par les agents.
_Éviter_ : transformer une approbation d'une simple maquette en autorisation implicite de construire tout le plan.

**Modes de prévisualisation complémentaires (Q66 confirmé)** : GitHub Actions artifacts/captures, GitHub Pages pour prototypes statiques si configuré, et environnement de preview préexistant du projet. Aucun de ces modes ne nécessite que `dev-automation` héberge un serveur central.
_Éviter_ : rendre obligatoire un hébergeur tiers ou publier par défaut un prototype sensible sur un site public.


## Déclenchement des prototypes et hébergement (Q71–Q73)

**Détour de prototypage fondé sur une question** : branche facultative du flux `grilling`/`ask-matt` quand un comportement d'état ou un choix visuel ne peut être validé par la conversation ; `prototype` traite une question précise et `handoff` transfère les apprentissages. Impeccable `shape` complète l'exploration UX, sans règle arbitraire de complexité.
_Éviter_ : générer un prototype pour chaque issue frontend ; transformer le code exploratoire en code applicatif.

**Rétention de preview hébergée** : durée de vie par défaut de 14 jours, configurable par dépôt, suivie d'une suppression automatisée.
_Éviter_ : confondre suppression des previews accessibles publiquement et suppression des décisions documentées.

**Isolation de preview publiée** : séparation effective entre prototype et site de production, avec interdiction de publier secrets et données personnelles. Un simple sous-chemin d'une origine partagée n'est pas une isolation de sécurité suffisante.
_Éviter_ : supposer que `/previews/42/` peut exécuter du JavaScript non fiable sans risque sur le même domaine que la production.

**Publication Pages sur consentement (Q70)** : possibilité pour `setup-repo` d’activer GitHub Pages pour des previews statiques uniquement après accord explicite de l’utilisateur ; configuration désactivée par défaut. Sans activation, les artifacts et captures restent la référence. L’activation exige une séparation du site de production (Q73) et la rétention configurable de 14 jours (Q71).
_Éviter_ : publier par défaut des prototypes sur le domaine de production ou assimiler un sous-chemin à une origine isolée.

## Isolation d'exécution, état Git hors branches et gouvernance EPURE (Q74–Q83)

**Proxy LLM de sandbox (Q74)** : processus sidecar local sur le runner GitHub Actions qui détient seul en mémoire la clé API LLM et les tokens d'installation, tandis que l'agent et les sous-processus de test/build du dépôt consommateur s'exécutent dans un conteneur isolé dépourvu de secrets dans ses variables d'environnement.
_Éviter_ : injecter `OPENAI_API_KEY` ou `ANTHROPIC_API_KEY` directement dans l'environnement où s'exécutent `npm test`, `pytest` ou les hooks `postinstall`.

**Traitement en lot des commentaires avec curseur (`last_processed_comment_id`, Q75)** : mécanisme par lequel un job sérialisé par `concurrency: issue-<N>` lit à son démarrage tous les commentaires humains postés depuis le dernier identifiant traité et les intègre séquentiellement, empêchant toute perte d'événement lorsque la file d'attente GitHub Actions compresse les runs en attente au-delà de deux événements.
_Éviter_ : se fier uniquement au payload `github.event.comment` du webhook déclencheur ou activer `cancel-in-progress: true`.

**Référence Git d'état d'orchestration (`refs/epure/state/<issue-number>`, Q76)** : référence Git dédiée hors branches standard (`refs/heads/*`) stockant l'état machine d'orchestration (curseur `last_processed_comment_id`, mandat de plan approuvé avec `spec_sha`, `approved_by`, statut `active|cancelled`, compteurs de tentatives par ticket) avec *compare-and-swap* atomique Git, doublée d'un tableau de bord Markdown lisible synchronisé dans le corps de l'issue GitHub.
_Éviter_ : polluer l'historique des branches applicatives `dev` et `main` avec des commits JSON d'état machine ou utiliser uniquement un commentaire d'issue sujet aux écrasements concurrents.

## Orchestration réelle multi-fournisseurs (`LLMClient`) et Publisher GitHub App (Q84–Q90)

**Continuité implicite de l'entretien de grill et de la révision de spécification (Q84)** : traitement automatique de tout commentaire humain posté sur une issue de pilotage dont la référence `refs/epure/state/<issue-number>` est en phase `grilling` (réponse au grill ou ajustement de la synthèse) ou en phase `spec` (demande de révision des artefacts de spécification sur `plan/<issue>-<slug>`) sans imposer de répéter une commande slash à chaque tour.
_Éviter_ : rejeter les réponses humaines ordinaires sous prétexte qu'elles ne commencent pas par `/epure`.

**Validation humaine de la frontière de Grill (Q85)** : passage de l'issue de pilotage en phase `grilling` avec statut `awaiting_human_approval` dès que la frontière de l'arbre de décisions est vide (`frontier_resolved: true`), publiant la synthèse structurée des décisions actées et attendant l'approbation humaine explicite via `/epure to-spec` (ou un commentaire libre pour rouvrir un round de grill) avant toute rédaction documentaire.
_Éviter_ : enchaîner automatiquement la fin du grill avec la génération de la spécification ou la création des sous-issues sans validation humaine de la synthèse de cadrage.

**Validation humaine de la spécification (Q85)** : séparation explicite entre `/epure to-spec` (qui génère et commite `GLOSSARY.md`, `docs/adr/NNNN-*.md`, `docs/specs/<slug>.md` et `DESIGN.md` sur `plan/<issue>-<slug>`, puis passe l'issue en phase `spec` / `awaiting_human_approval` où tout commentaire libre révise la spécification) et `/epure to-tickets` (qui découpe la spécification validée en un DAG acyclique de tickets GitHub `ready-for-agent` avec `blocked_by` et passe l'issue en phase `tickets` / `awaiting_human_approval` en attente de `/epure approve`).
_Éviter_ : créer les sous-issues GitHub dès `/epure to-spec` avant que l'humain ait pu relire et valider la spécification sur `plan/<issue>-<slug>`.

**Jeton d'installation GitHub App éphémère (Q87)** : jeton court obtenu en signant un JWT RS256 avec `EPURE_AGENT_APP_ID` et `EPURE_AGENT_APP_PRIVATE_KEY` puis en appelant l'API d'installation GitHub du dépôt cible, utilisé par le publisher isolé pour créer branches, commits, tickets, PRs et checks, puis révoqué immédiatement.
_Éviter_ : exposer la clé privée PEM au processus agent ou partager un PAT personnel permanent.

## Gouvernance Rulesets, Roster de Review Multi-Agents et Squash Sémantique par IA (Q91–Q96)

**Séparation des trois Rulesets de gouvernance (`epure-feature-governance`, `epure-dev-governance`, `epure-release-immutability`, Q91 & Q95)** : découpage explicite des règles GitHub Repository Rulesets en trois périmètres distincts (`refs/heads/feature/*` avec `Agent App` en bypass PR pour le squash-merge autonome des tâches validées ; `refs/heads/dev` exigeant un merge humain dans l'interface GitHub, exception faite de la fusion documentaire `plan/* -> dev` déclenchée par `/epure approve`, avec `required_approving_review_count: 0` par défaut pour la compatibilité mainteneur solo et configurable via `--require-pr-approvals <N>` ; `refs/heads/main` et `refs/tags/v*` réservés à `Release App`).
_Éviter_ : mutualiser `dev` et `feature/*` dans un unique Ruleset qui autoriserait l'Agent App à fusionner du code applicatif dans `dev` sans validation humaine, ou bloquer un mainteneur solo sur ses propres PRs.

**Roster de reviewers spécialisés et transverses (`.cursor/agents/*`, Q92 & Q93)** : ensemble de définitions de rôles d'audit en lecture seule initialisé par `setup-repo` dans le dépôt consommateur (spécialistes `domain-backend-reviewer`, `frontend-reviewer`, `infra-reviewer` ; transverses `architecture-reviewer`, `security-reviewer`, `spec-parity-reviewer`, `standards-reviewer`, `accessibility-reviewer`, `design-reviewer` ; et `user-advocate`), enrichi lors de `/epure plan` avec les personas et invariants du domaine, mais toujours chargé à l'exécution depuis la branche de base de confiance (`dev`) avec repli sur les templates embarqués d'EPURE, et classé comme chemin sensible interdisant toute auto-modification sur `task/*`.
_Éviter_ : charger un prompt de reviewer depuis la branche non fiable `task/*` inspectée (risque d'auto-approbation par injection de prompt) ou dépasser le plafond de 4 reviewers pertinents sélectionnés par diff.

**Porte UX orientée personas (`user-advocate`, modes `design-gate` et `implementation-review`, Q96)** : sous-agent évaluant le produit selon les personas d'utilisateurs finaux propres au domaine ; intervient d'abord en mode `design-gate` à l'issue du Grill sur `plan/*` (conjointement à `DESIGN.md`) pour enrichir les critères d'acceptation UX des tickets avant `/epure approve`, puis en mode `implementation-review` (conjointement au check `impeccable-gate`) comme contrôle bloquant sur les PRs touchant l'interface.
_Éviter_ : reporter toute la validation UX et d'accessibilité après le codage ou ignorer les impasses de parcours multi-rôles.

**Synthèse de message de squash sémantique par IA (Q94)** : génération juste avant chaque squash-merge, par un modèle léger à température nulle inspectant le diff consolidé de la PR, d'un titre Conventional Commit (`type(scope): summary (#PR)`) synchronisé sur la PR et d'un corps concis listant les changements effectifs, en utilisant `Refs #<ticket>` lors de l'intégration `task/* -> feature/*` et `Closes #<issue>` / `Closes #<ticket>` uniquement lors de l'atterrissage sur la branche par défaut `dev`.
_Éviter_ : conserver des messages de commits intermédiaires de debug dans l'historique de `feature/*` ou `dev`, ou supposer que `Closes #N` sur une branche non-default ferme automatiquement le ticket GitHub.

## Taxonomie du flux d'orchestration et documentation bilingue (Q97–Q103)

**Portes de validation humaine obligatoires (4 jalons, Q101)** : les quatre points de décision où l'intervention explicite d'un contributeur autorisé (`write` ou supérieur) est indispensable et ne peut jamais être déléguée à un agent : (1) lancement `/epure plan` et réponses au Grill sur l'issue de pilotage, (2) signature du plan approuvé par `/epure approve` verrouillant `spec_sha` dans `refs/epure/state/<issue>`, (3) validation humaine d'intégration par revue et squash-merge humain de la PR finale `feature/* -> dev`, et (4) release à déclenchement humain (`workflow_dispatch` de promotion fast-forward `dev -> main`).
_Éviter_ : autoriser l'Agent App à fusionner du code applicatif dans `dev` ou `main` sans décision humaine explicite.

**Étapes automatisées obligatoires (Q101)** : séquence déterministe exécutée par l'orchestrateur sur chaque fonctionnalité approuvée : génération documentaire sur `plan/<issue>-<slug>` (`GLOSSARY.md`, `docs/adr/`, `docs/specs/<slug>.md`) et création du graphe de tickets d'implémentation avec `blocked_by`, boucle TDD en sandbox sans secret (`npm test`, `npm run build`, `verify-contract`), revue indépendante multi-agents chargée depuis `dev` avec auto-remédiation bornée (`max_code_fix_attempts = 3`) et intégration sérialisée (`task/* -> feature/*`) par squash sémantique IA, puis revue de synthèse complète sur la PR finale `feature/* -> dev`.
_Éviter_ : contourner la sandbox sans secret ou intégrer une branche `task/*` sans revue indépendante liée au SHA.

**Étapes facultatives ou conditionnelles (Q101)** : opérations activées uniquement selon la nature du changement ou la demande explicite d'un contributeur autorisé : détour exploratoire `/prototype` (Q72) et preview GitHub Pages isolée (Q70, désactivée par défaut), génération de `DESIGN.md` + `user-advocate` (`design-gate` et `implementation-review`) + `impeccable-gate` (Q96, activés automatiquement uniquement lorsque le projet ou le diff comporte une surface UI/frontend), commandes de pilotage granulaire (`/epure to-spec`, `/epure to-tickets`, `/epure status`, `/epure cancel`), et escalade humaine (`needs-human`) en cas d'exception sensible ou d'épuisement des trois tentatives de correction.
_Éviter_ : imposer les contrôles UI Impeccable ou un prototype exploratoire sur des projets ou tickets purement backend/CLI.

## Vérification polyglotte et boucle de CI externe multi-workflows (Q104–Q111)

**Profil de vérification polyglotte (`verification.targets`, Q104 & Q108)** : déclaration par sous-projet dans `.github/agents.yml` (générée par `setup-repo` et repliée au runtime par inspection hybride des manifestes Node/Python/Rust/Go, des orchestrateurs `Makefile`/`Justfile`/`Taskfile`/`turbo.json` et de l'ensemble des workflows `.github/workflows/*.{yml,yaml}` hors EPURE), toujours chargée à l'exécution depuis la branche de confiance (`dev`) et classée comme chemin sensible sur `task/*`.
_Éviter_ : supposer un unique `package.json` à la racine, un fichier unique nommé `ci.yml`, ou autoriser une branche `task/*` à altérer ses propres commandes de test.

**Vérification locale de pré-publication (Stage 1, Q105)** : exécution dans un clone Git persistant de la sandbox sans secret, avant tout commit ou ouverture de PR, des commandes d'installation, de génération de code (`codegen`), de typage statique (`typecheck`), de lint et de tests unitaires/scripts ne nécessitant aucun conteneur de service externe, ciblées selon les `path_patterns` des fichiers modifiés.
_Éviter_ : retourner un succès par défaut en l'absence de `package.json` racine ou tenter de démarrer en sandbox locale les services lourds (PostgreSQL, Docker multi-stage) relevant de la CI GitHub Actions.

**Porte de CI externe multi-workflows et boucle d'auto-réparation (Stage 3, Q106–Q110)** : attente déterministe (avec fenêtre d'amorçage et corrélation des filtres `on.pull_request`/`push` sur tous les workflows `.github/workflows/*.{yml,yaml}` hors EPURE) de la complétude des *check-runs* et *workflow_runs* externes sur le `head_sha` d'une PR, suivie en cas d'échec applicatif de l'extraction assainie des annotations et logs d'erreur (~12 Ko) pour alimenter jusqu'à 3 rondes unifiées de remédiation (*Review IA + CI externe*), avec relance sans pénalité sur panne transitoire d'infrastructure et réconciliation idempotente des PRs déjà ouvertes.
_Éviter_ : fusionner `task/* -> feature/*` avant la fin des workflows CI externes, considérer zéro check-run à $T+0$ comme un succès, ou gaspiller une tentative de code sur un échec réseau du runner.

## Routeur LLM multi-fournisseurs, sorties structurées et ergonomie `/epure` (ADR-0029)

### Vocabulaire canonique

| Terme canonique | Identifiant technique | Définition et invariant |
| --- | --- | --- |
| **Routeur LLM multi-fournisseurs** | `LLMClient` | Client HTTP TypeScript sans dépendance externe (inspiré de `giskard-llm`) routant chaque appel selon le préfixe `<provider>/<model>` (`openai/`, `azure/`, `azure_ai/`, `google/`, `gemini/`, `anthropic/` ou un alias nommé déclaré dans la section `providers:` de `.github/agents.yml` avec résolution différée `os.environ/VAR_NAME`), garantissant l'absence de bascule automatique inter-fournisseurs sur erreur d'authentification ou de quota (ADR-0012). |
| **Sortie structurée par schéma** | `ResponseSchemaSpec<T>` | Contrat associant un JSON Schema strict (transmis nativement au fournisseur via `responseSchema`, `response_format.json_schema` ou `output_config.format`) et un validateur TypeScript d'exécution, remplaçant toute extraction heuristique de JSON par expression régulière. Sur Google Gemini avec outils d'exploration (`tools`), le client exécute la boucle d'outils puis déclenche un tour final dédié (`functionCallingConfig.mode = "NONE"`) avec `responseSchema` activé. |
| **Aide-mémoire contextuel des commandes `/epure`** | `formatEpureCommandsSpoiler` | Bloc Markdown repliable (`<details>`) inséré systématiquement au pied des commentaires d'issues, des sous-issues de tickets et des descriptions de Pull Requests générés par `EPURE`, récapitulant les commandes disponibles (`/epure plan`, `/epure to-spec`, `/epure to-tickets`, `/epure approve`, `/epure status`, `/epure cancel`) et mettant en évidence la prochaine action attendue selon la phase courante. |

**Routeur LLM multi-fournisseurs** (`LLMClient`) : Client HTTP TypeScript sans dépendance externe (inspiré de `giskard-llm`) routant chaque appel selon le préfixe `<provider>/<model>` (`openai/`, `azure/`, `azure_ai/`, `google/`, `gemini/`, `anthropic/` ou un alias nommé déclaré dans la section `providers:` de `.github/agents.yml` avec résolution différée `os.environ/VAR_NAME`), garantissant l'absence de bascule automatique inter-fournisseurs sur erreur d'authentification ou de quota (ADR-0012).
_Éviter_ : coupler l'orchestrateur à un unique fournisseur au runtime, stocker des clés API en clair dans `.github/agents.yml`, ou basculer automatiquement vers un fournisseur de secours en cas d'erreur `401`/`402`/`403`.

**Sortie structurée par schéma** (`ResponseSchemaSpec<T>`) : Contrat associant un JSON Schema strict (transmis nativement au fournisseur via `responseSchema`, `response_format.json_schema` ou `output_config.format`) et un validateur TypeScript d'exécution, remplaçant toute extraction heuristique de JSON par expression régulière. Sur Google Gemini avec outils d'exploration (`tools`), le client exécute la boucle d'outils puis déclenche un tour final dédié (`functionCallingConfig.mode = "NONE"`) avec `responseSchema` activé.
_Éviter_ : extraire du JSON par expression régulière depuis du texte libre ou désactiver la validation de schéma lorsqu'une boucle d'outils est active.

**Aide-mémoire contextuel des commandes `/epure`** : Bloc Markdown repliable (`<details>`) inséré systématiquement au pied des commentaires d'issues, des sous-issues de tickets et des descriptions de Pull Requests générés par `EPURE`, récapitulant les commandes disponibles (`/epure plan`, `/epure to-spec`, `/epure to-tickets`, `/epure approve`, `/epure status`, `/epure cancel`) et mettant en évidence la prochaine action attendue selon la phase courante.
_Éviter_ : publier des commentaires d'orchestration ou des escalades `needs-human` sans rappeler à l'opérateur humain les commandes de reprise ou d'annulation disponibles.
