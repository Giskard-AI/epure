---
status: accepted
---
# ADR-0035 : Usage des jetons par ticket et par epic dans l'état du plan, coût calculé à l'affichage

- **Statut** : Accepté
- **Date** : 2026-11-08
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0012 (modifie sa décision 1 et ses conséquences), ADR-0024, ADR-0034

## Contexte

L'ADR-0012 interdit tout compteur et tout coût stocké dans GitHub : la facturation reste chez le fournisseur LLM. Or le tableau de bord du fournisseur ne dit pas combien a coûté un ticket ou une epic, et en v3 un moteur d'agent appelle l'API depuis la sandbox, à travers le **Proxy LLM de sandbox** (ADR-0034), sans passer par le `LLMClient` de l'orchestrateur. Le seul relevé existant est la ligne `epure-llm-usage` des journaux de job, perdue avec eux. Le budget (plafond, suspension) reste hors périmètre.

## Décisions

1. `refs/epure/state/<issue>` porte un champ `token_usage` : pour l'issue de pilotage (clé `epic` : planification, intégration de la fonctionnalité et sa revue) et pour chaque numéro de ticket, par phase (`plan`, `grilling`, `spec`, `tickets`, `implementation`, `review`, `fixes`, `integration`), par modèle `<fournisseur>/<modèle>`, les compteurs `requests`, `input_tokens` (jetons en cache inclus), `cached_input_tokens`, `output_tokens` (jetons de réflexion inclus) et `thinking_tokens`. Le total de l'epic se calcule, il n'est pas stocké.
2. Un seul canal : chaque réponse LLM est signalée par `reportLLMUsage` au registre d'usage du job, qui l'attribue à la phase et au ticket de l'appel en cours (`withUsageAttribution`). Le `LLMClient` le fait pour les phases sans agent, le proxy pour les sessions d'agent qui le traversent. Un moteur dont le trafic ne passe pas par le proxy appelle le même `reportLLMUsage` une fois par session, avec ses compteurs ou une marque `usage_unavailable` ; son fournisseur est le nom du moteur. Le proxy demande `stream_options.include_usage: true` aux flux compatibles OpenAI et lit l'usage de chaque réponse relayée (Anthropic `message_start` puis `message_delta`, dernier fragment `chat.completions` ou `response.completed` d'OpenAI, dernier `usageMetadata` de Gemini, ou corps JSON). Le modèle vient du chemin quand celui-ci le nomme (déploiement Azure, Gemini, Vertex), sinon du corps de la requête s'il respecte `^[\w.@:/-]{1,128}$`, sinon il vaut `unknown`. Au-delà de 16 modèles distincts nommés par la sandbox dans un job, les suivants comptent sous `<fournisseur>/other` ; les modèles du `LLMClient` n'entrent pas dans ce plafond. Une réponse sans usage lisible compte une requête `usage_unavailable` : ses jetons sont inconnus, jamais nuls.
3. L'usage d'un job est écrit avec chaque mise à jour *compare-and-swap* de l'état de l'issue de pilotage que le job fait déjà. En fin de job, si de l'usage reste en attente, EPURE fait au plus un commit d'état supplémentaire pour l'écrire. Un *compare-and-swap* refusé garde l'usage en attente pour l'écriture suivante ; un *compare-and-swap* qui lève une erreur relit la référence et considère l'usage écrit si elle porte déjà l'enregistrement tenté. Si l'écriture de fin de job échoue ou est refusée (par exemple par la garde des états terminaux `cancelled` et `done`), une ligne sur la sortie standard donne le nombre de réponses non écrites et la raison. Un job tué perd au plus l'usage postérieur à sa dernière écriture.
4. Le coût n'est jamais stocké. Il est calculé à l'affichage depuis la section facultative `pricing:` de `.github/agents.yml` (lue sur `dev`, sinon `main`) : dollars par million de jetons d'entrée, d'entrée en cache et de sortie par modèle, avec l'URL de la source et la date de lecture, comme `pricing` dans `epure.e2e.json`. Les jetons de réflexion sont facturés au prix de sortie. EPURE ne récupère aucun prix à l'exécution. Sans prix pour chacun des modèles d'une ligne, la ligne n'affiche que les jetons. Si une requête de la ligne est `usage_unavailable`, le coût affiché est un minimum (`≥ $X`). La source des prix n'est citée que si un coût est affiché.
5. L'usage est affiché par `/epure status` (total de l'epic, planification et intégration, chaque ticket, sources des prix) et dans la section `## LLM Usage` de la PR `feature/* -> dev` et du commentaire de fin d'exécution, où chaque ticket a sa ligne : aucun commentaire de fin de ticket n'existe pour le porter. La section de la PR, entre les marqueurs `<!-- epure-llm-usage:start -->` et `<!-- epure-llm-usage:end -->`, est réécrite avec le total courant à chaque passage d'intégration de la fonctionnalité, y compris à la reprise quand la PR existe déjà ; le reste du corps n'est pas modifié. Le tableau de bord du corps de l'issue ne le reprend pas.

## Alternatives écartées

- **Stocker le coût** : un prix change ; un coût calculé à l'écriture deviendrait faux sans que rien ne le signale.
- **Commit d'état dédié à chaque relevé** : double les écritures sur la référence et les conflits *compare-and-swap*, pour une donnée qui peut attendre l'écriture suivante. Seul l'usage resté en attente en fin de job justifie un commit.
- **Rendre l'usage du proxy sur le résultat de la sandbox en plus du registre** : deux canaux pour la même réponse, donc un risque de double compte et deux contrats pour les moteurs à venir.
- **Récupérer les prix chez le fournisseur** : aucune API de prix commune, et un appel réseau de plus depuis le runner.
- **Compter zéro quand le moteur ne rend pas d'usage** : un total faux qui passe pour exact.

## Conséquences

- L'ADR-0012 reste valable pour le budget : EPURE ne plafonne ni ne suspend rien selon un coût. Elle ne l'est plus pour le relevé des jetons, désormais stocké, ni pour le coût, désormais affiché.
- Le coût affiché est une estimation : l'écriture en cache d'Anthropic est comptée au prix d'entrée, et les requêtes `usage_unavailable` n'y figurent pas (leur nombre est affiché).
- La clé d'un prix est le modèle tel qu'il apparaît dans l'état et dans les lignes `epure-llm-usage` : la famille de fournisseur (`google`, `anthropic`, `azure`…) puis le modèle envoyé à l'API, pas l'alias de `providers:`.
- L'état grossit d'environ 150 octets par couple (phase, modèle) et par ticket ; à surveiller avec #116. Le plafond de modèles par job borne ce que la sandbox peut y écrire.
- Le moteur Cursor (M4) n'est pas couvert : son trafic va au service de Cursor, pas au proxy. Son adaptateur suivra le contrat de la décision 2 (#146).
- Le proxy relaie au plus 4 requêtes à la fois ; les suivantes attendent leur tour, sans délai, et le délai de réception du corps ne court qu'à partir de leur tour. Un corps de requête qu'il ne peut pas réécrire reçoit une réponse `400` et le proxy continue de servir.
