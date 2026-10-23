---
status: accepted
supersedes: 0007
---
# Publier des Reusable Workflows et des Custom Actions dès la V1

## Contexte

Le projet `dev-automation` doit être utilisable par les dépôts de son propriétaire et par des tiers, sans service central géré par l'auteur. Dans l'ADR-0007, un dépôt central recevait des `repository_dispatch` pour exécuter les agents ; ce modèle implique un routage inter-dépôts, une identité centrale et potentiellement la gestion de dépenses ou de secrets d'autrui.

GitHub permet deux primitives complémentaires :
- les **Reusable Workflows** (`workflow_call`), qui orchestrent des jobs dans le contexte du dépôt appelant ;
- les **Custom Actions** (`action.yml`), appelées dans les jobs du consommateur, qui encapsulent une fonctionnalité mais ne créent pas de frontière de sécurité.

## Décision acceptée — révision de Q21 et contrat public V1

1. `dev-automation` est un **dépôt public et open source, librement adoptable par des tiers**, sans dépendance à des clés LLM ni à des GitHub Apps appartenant au mainteneur. Il est un **dépôt de distribution** contenant les deux interfaces publiques dès la V1 :
   - `.github/workflows/{plan,implement,review,reconcile,issue-agent}.yml` : workflows réutilisables pour les processus complets ;
   - `actions/{authorize,run-agent,publish,manage-issues}/action.yml` : actions autonomes composables.
2. Les agents s'exécutent sur les **runners des dépôts appelants**, avec leurs propres secrets, droits et quotas. Chaque dépôt appelant conserve ses workflows de déclenchement (par exemple `issue_comment`) et peut invoquer les workflows publiés, sans relais `repository_dispatch` pour le chemin normal.
3. Les workflows complets garantissent les frontières de sécurité validées (autorisation, séparation exécuteur/publisher, revue, garde-fous opérationnels). Les actions unitaires documentent leurs **préconditions** et ne prétendent pas reproduire seules toutes les garanties des workflows : leur sécurité dépend aussi du job appelant.
4. **Les deux interfaces sont publiques et supportées dès la V1** : documenter entrées/sorties, permissions, secrets requis, cas d'erreur, exemples et versioning pour chacune. Une modification incompatible exige une nouvelle version majeure ; les correctifs compatibles restent dans la même majeure.
5. Fournir des exemples d'appels figés sur des **SHA complets** pour les installations sensibles, ainsi que des tags de release versionnés pour l'ergonomie. La maintenance de tags majeurs (`v1`) est une politique de publication à préciser, car un tag mobile ne garantit pas l'immuabilité.
6. La logique commune peut rester dans une bibliothèque interne (par exemple TypeScript). Elle ne constitue pas une troisième API publique garantie.
7. Dans les projets consommateurs, les **secrets et identités GitHub App restent propres à chaque dépôt**. Le partage des scripts ne doit pas introduire une dépendance à une infrastructure d'exécution centralisée.

## Conséquences

### Avantages
- Adoption modulaire : processus clés en main ou seules actions nécessaires.
- Distribution publique sans faire payer les runners ou les modèles des tiers au mainteneur.
- Publication et correction du moteur indépendamment des releases applicatives.
- Contrats explicites et testables pour chaque interface.

### Coûts et risques
- Double surface de compatibilité à maintenir dès la première version.
- Tests de contrat et documentation des workflows **et** actions obligatoires.
- Une action directe hérite des permissions, secrets et limites du job appelant ; elle n'apporte pas l'isolation des jobs distincts.
- Les changements dans `dev-automation` doivent être publiés, versionnés et validés avant adoption par un projet consommateur.

## Approvisionnement des skills — Q43

Les skills externes (dont ceux de Matt Pocock) sont intégrés à des révisions identifiées et éventuellement adaptés au dialogue GitHub Issues. Leurs licences et attributions doivent être conservées dans la distribution, après vérification des fichiers effectivement repris. Les mises à jour passent par des PR et les tests de compatibilité, jamais par téléchargement silencieux de la dernière version au moment d'exécuter un agent.

## Sujets encore ouverts
- Politique exacte de support SemVer (tags mobiles `v1`, période de support, dépréciations).
- Choix du moteur d'agent de référence et garanties de portabilité entre Pi et Codex.

