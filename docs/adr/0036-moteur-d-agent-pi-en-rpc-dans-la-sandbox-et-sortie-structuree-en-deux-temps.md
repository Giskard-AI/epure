---
status: accepted
---
# ADR-0036 : Moteur d'agent Pi en mode RPC dans la sandbox et sortie structurée en deux temps

- **Statut** : Accepté
- **Date** : 2026-11-09
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0016 (met en œuvre sa décision 4 pour Pi), ADR-0033, ADR-0034, ADR-0035

## Contexte

Jusqu'en v2, l'implémentation et la remédiation d'un ticket étaient un appel LLM avec une boucle d'outils maison (`read_repo_file`, `write_repo_file`, `patch_repo_file`…) qui rendait un JSON `generated_ticket_implementation` : messages de commit, résumé de tests et contenu des fichiers. Le modèle ne pouvait ni lancer les tests ni parcourir le dépôt comme un développeur, et le contenu des fichiers transitait par la sortie structurée, ce qui imposait le **Tampon de mutation incrémentale de ticket** et le **Repli segmenté fichier par fichier** (ADR-0033). L'ADR-0016 prévoyait un adaptateur de moteur d'agent avec Pi par défaut ; l'ADR-0034 a préparé la sandbox (proxy inverse, **Session d'agent**) et l'ADR-0035 le canal d'usage.

## Décisions

1. Un seul **Port de moteur d'agent** (`AgentEngine`, `src/agent/engine.ts`) : une session reçoit un rôle, une politique d'outils (`write` ou `read_only`), des instructions, un message, un répertoire de travail, un délai et un modèle `<fournisseur>/<modèle>` ; elle rend le message final de l'agent et le diff du répertoire de travail par rapport à un instantané pris avant la session. Le diff vient de l'instantané, jamais de ce que le modèle déclare. Le port ne rend pas l'usage : les requêtes de la session traversent le **Proxy LLM de sandbox**, qui les compte par `reportLLMUsage` (ADR-0035, décision 2) ; un second relevé par le port compterait deux fois.
2. L'instantané (`snapshotWorktree`) utilise un dépôt Git temporaire hors du répertoire de travail (`--git-dir` séparé, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) : un `.git/config` déposé dans le dépôt (hooks, `core.fsmonitor`) n'est jamais lu. Les liens symboliques, sous-modules et fichiers binaires sont exclus du diff.
3. Pi (`@earendil-works/pi-coding-agent`) est épinglé à une version exacte ; `npm run build` copie son bundle `dist/bundle` tel quel dans `dist/vendor/pi` (pas de re-bundle), avec un `package.json` réduit pour que Pi ne lise ni celui d'EPURE ni celui du dépôt. Pi tourne en mode RPC (`rpc-entry.js`, JSONL sur stdin/stdout) dans une **Session d'agent** sous `networkPolicy: "proxy_only"` : `--no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --offline`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, télémétrie et analytique coupées dans `settings.json`. Son `models.json`, écrit dans le répertoire personnel éphémère de la session, pointe vers l'URL du proxy et ne contient que le nonce (`$EPURE_LLM_PROXY_NONCE`), jamais la clé.
4. Traduction `<fournisseur>/<modèle>` (`translateModelForPi`) : `anthropic`, `openai` et `google` remplacent l'URL du fournisseur intégré à Pi par celle du proxy ; `openrouter`, `azure`, `azure_ai`, `vertex` et les alias de `providers:` deviennent un fournisseur Pi `epure` parlant l'API compatible (`openai-completions` ou `google-generative-ai`). Politique d'outils : `write` = `read,bash,edit,write,grep,find,ls` ; `read_only` = `read,grep,find,ls` (sans `bash`).
5. Une erreur HTTP du fournisseur pendant la session est lue par le proxy (`observeLlmResponse`) et classée comme pour le `LLMClient` (`classifyHttpError` : authentification, quota, requête invalide…), pour que l'escalade garde la même raison. Une session qui dépasse son délai reçoit `abort`, puis la sandbox la tue après un délai de grâce (`AGENT_TIMEOUT`).
6. **Sortie structurée en deux temps** : une phase qui doit rendre du JSON exécute d'abord la session d'agent, puis un appel direct `callLlmJson` sans outils qui produit le JSON à partir du message final et de la liste des fichiers changés. Pour un ticket, ce JSON se réduit à `ticket_session_summary` (`commit_message`, `test_summary`) ; les fichiers sont ceux du diff. `validateWorkspaceFileOperations`, `validateTicketIntegrityGuard` et la **Vérification locale de pré-publication (Stage 1)** restent des portes après l'agent.

## Mise en œuvre progressive

- Étape 5a (#99) : implémentation, retries Stage 1 et remédiation revue/CI d'un ticket passent par le port (rôles `implementer` et `fixer`, politique `write`) sur le checkout Stage 1 ; l'action `orchestrate-issue` injecte le moteur Pi. Sans moteur injecté, la boucle d'outils maison reste le chemin de repli.
- Reste de #99 : correction de la PR de fonctionnalité, reviewers (`read_only`, au plus 4 sessions simultanées), audit de convergence, résolution de conflits 3-way sur un vrai checkout avec un ensemble en conflit au niveau du hunk (lève l'écart de l'ADR-0031), réconciliation des ADR, grill, spécification et découpage en tickets. Restent des appels directs : audit et réécriture Goldfish, message de squash, `user-advocate` et porte design.
- Étape 6 (#100) : suppression de la boucle d'outils maison, du **Tampon de mutation incrémentale de ticket**, du **Repli segmenté fichier par fichier** et du schéma `generated_ticket_implementation`.

## Alternatives écartées

- **Re-bundler Pi avec EPURE** : mélange ses dépendances aux nôtres et rend la version embarquée invérifiable par rapport au paquet publié.
- **Faire rendre les fichiers dans le JSON final de l'agent** : réintroduit la troncature et les contenus inventés que l'ADR-0033 contournait ; le diff du répertoire de travail est la seule source fiable.
- **Rendre l'usage dans le résultat de la session** : second canal à côté du proxy, donc double compte (ADR-0035).
- **Lancer Pi hors sandbox avec la vraie clé** : la clé deviendrait lisible par le code du dépôt que l'agent exécute avec `bash`.

## Conséquences

- Le message de commit d'un ticket coûte un appel direct de plus, compté en `implementation` ou `fixes` comme la session.
- Un runner sans `bubblewrap` et `landrun` fonctionnels ne peut plus implémenter de ticket en CI (ADR-0034, décision 3).
- Le prompt d'implémentation décrit encore les outils `*_repo_file` et le schéma JSON de la boucle maison ; les instructions de la session précisent qu'ils n'existent pas. Il sera réécrit avec l'étape 6.
- `dist/vendor/pi` ajoute environ 10 Mo au dépôt ; une mise à jour de Pi est un changement de `package-lock.json` suivi d'une reconstruction.
