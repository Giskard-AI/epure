---
status: accepted
---
# ADR-0035 : Usage des jetons par ticket et par epic dans l'état du plan, coût calculé à l'affichage

- **Statut** : Accepté
- **Date** : 2026-11-08
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0012 (modifie ses décisions 1 et ses conséquences), ADR-0024, ADR-0034

## Contexte

L'ADR-0012 interdit tout compteur et tout coût stocké dans GitHub : la facturation reste chez le fournisseur LLM. Or le tableau de bord du fournisseur ne dit pas combien a coûté un ticket ou une epic, et en v3 un moteur d'agent appelle l'API depuis la sandbox, à travers le **Proxy LLM de sandbox** (ADR-0034), sans passer par le `LLMClient` de l'orchestrateur. Le seul relevé existant est la ligne `epure-llm-usage` des journaux de job, perdue avec eux. Le budget (plafond, suspension) reste hors périmètre.

## Décisions

1. `refs/epure/state/<issue>` porte un champ `token_usage` : pour l'epic (`epic`, planification et intégration) et pour chaque numéro de ticket, par phase (`plan`, `grilling`, `spec`, `tickets`, `implementation`, `review`, `fixes`, `integration`), par modèle `<fournisseur>/<modèle>`, les compteurs `requests`, `input_tokens` (jetons en cache inclus), `cached_input_tokens`, `output_tokens` (jetons de réflexion inclus) et `thinking_tokens`. Le total de l'epic se calcule, il n'est pas stocké.
2. Les deux chemins alimentent le même relevé, au même format : le `LLMClient` pour les phases sans agent, le proxy pour les sessions d'agent. Le proxy demande `stream_options.include_usage: true` aux flux compatibles OpenAI, lit l'usage de chaque réponse relayée (Anthropic `message_start` puis `message_delta`, dernier fragment `chat.completions` ou `response.completed` d'OpenAI, dernier `usageMetadata` de Gemini, ou corps JSON), prend le modèle dans la requête de la sandbox et rend les totaux sur `SandboxExecutionResult.llm_usage`. Une réponse sans usage lisible compte une requête `usage_unavailable` : ses jetons sont inconnus, jamais nuls.
3. L'usage d'un job est écrit avec chaque mise à jour *compare-and-swap* de l'état que le job fait déjà : aucun commit supplémentaire. Un *compare-and-swap* refusé garde l'usage en attente pour l'écriture suivante ; un job tué perd au plus l'usage postérieur à sa dernière écriture.
4. Le coût n'est jamais stocké. Il est calculé à l'affichage depuis la section facultative `pricing:` de `.github/agents.yml` (lue sur `dev`, sinon `main`) : dollars par million de jetons d'entrée, d'entrée en cache et de sortie par modèle, avec l'URL de la source et la date de lecture, comme `pricing` dans `epure.e2e.json`. Les jetons de réflexion sont facturés au prix de sortie. EPURE ne récupère aucun prix à l'exécution. Sans prix pour chacun des modèles d'une ligne, la ligne n'affiche que les jetons.
5. L'usage est affiché par `/epure status` (total de l'epic, planification et intégration, chaque ticket, sources des prix), sur la ligne de chaque ticket terminé et dans la section `## LLM Usage` de la PR `feature/* -> dev` et du commentaire de fin d'exécution. Le tableau de bord du corps de l'issue ne le reprend pas.

## Alternatives écartées

- **Stocker le coût** : un prix change ; un coût calculé à l'écriture deviendrait faux sans que rien ne le signale.
- **Commit d'état dédié à l'usage** : double les écritures sur la référence et les conflits *compare-and-swap*, pour une donnée qui peut attendre l'écriture suivante.
- **Récupérer les prix chez le fournisseur** : aucune API de prix commune, et un appel réseau de plus depuis le runner.
- **Compter zéro quand le moteur ne rend pas d'usage** : un total faux qui passe pour exact (Cursor, M4).

## Conséquences

- L'ADR-0012 reste valable pour le budget : EPURE ne plafonne ni ne suspend rien selon un coût. Elle ne l'est plus pour le relevé des jetons, désormais stocké, ni pour le coût, désormais affiché.
- Le coût affiché est une estimation : l'écriture en cache d'Anthropic est comptée au prix d'entrée, et les requêtes `usage_unavailable` n'y figurent pas (leur nombre est affiché).
- La clé d'un prix est le modèle tel qu'il apparaît dans l'état et dans les lignes `epure-llm-usage` : la famille de fournisseur (`google`, `anthropic`, `azure`…) puis le modèle envoyé à l'API, pas l'alias de `providers:`.
- L'état grossit d'environ 150 octets par couple (phase, modèle) et par ticket ; à surveiller avec #116.
