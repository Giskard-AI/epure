---
status: accepted
---
# ADR-0034 : Proxy LLM inverse en streaming vers le seul fournisseur du ticket et confinement noyau obligatoire en CI

- **Statut** : Accepté
- **Date** : 2026-11-08
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0011, ADR-0023, ADR-0029, ADR-0030 (remplace la dernière règle de sa décision 2)

## Contexte

En v3, un moteur d'agent comme Pi appelle lui-même l'API HTTP du fournisseur depuis la sandbox, en streaming, avec le SDK de ce fournisseur. Le **Proxy LLM de sandbox** de l'ADR-0023 était un relais générique : il ne connaissait ni le fournisseur ni ses chemins, et l'ADR-0030 ne rendait le confinement noyau obligatoire que si `EPURE_ENFORCE_KERNEL_SANDBOX=true` était défini. Une variable oubliée ou écrasée suffisait donc à lancer du code non fiable sans Landlock ni namespaces sur un runner CI qui détient des clés.

Cette ADR ne couvre que les moteurs d'agent qui appellent l'API HTTP d'un fournisseur. Cursor (M4) passe par son propre backend : son chemin réseau et ses identifiants feront l'objet d'une ADR ultérieure.

## Décisions

1. Le proxy est un proxy inverse lié au fournisseur du modèle du ticket (`resolveProviderUpstream`) : il n'accepte que `POST` sur les chemins déclarés de ce fournisseur, exige le nonce éphémère à la place de la clé (en-tête d'authentification du SDK ou `?key=`), injecte la vraie clé dans l'en-tête attendu par le fournisseur et relaie la réponse morceau par morceau (SSE). Il ne suit jamais une redirection (la clé ne part pas vers une autre origine), plafonne le corps de requête à 20 Mo et n'envoie la clé qu'en `https` (`http` seulement vers la boucle locale de test). Le chemin de réponse expose un point d'observation (`observeResponse`) pour le futur décompte des jetons (#125). _Ce décompte est fait par le proxy lui-même : ADR-0035._
2. La route LLM de la sandbox ne devine rien : le modèle doit commencer par un fournisseur connu ou par un alias déclaré dans la section `providers:` de `.github/agents.yml`, lue sur `dev` (sinon `main`) par l'API GitHub comme le fait l'orchestrateur. Un alias n'utilise que la clé qu'il déclare (`api_key`), jamais `OPENAI_API_KEY` ni `LLM_API_KEY`. Modèle vide : `LLM_MODEL_MISSING` ; préfixe inconnu, point d'accès manquant ou `http` distant : `LLM_ROUTE_INVALID`.
3. En CI (`GITHUB_ACTIONS` ou `CI` à `true` ou `1`, dans l'environnement de l'orchestrateur ou dans celui transmis), toute exécution sandboxée refuse de démarrer sans confinement noyau complet pour chacune de ses phases (`SANDBOX_ISOLATION_UNAVAILABLE`). Aucune variable ne permet de désactiver cette règle ; `EPURE_ENFORCE_KERNEL_SANDBOX=true` ne sert plus qu'à l'exiger hors CI.
4. Le confinement complet passe toujours par un namespace `bubblewrap` : `/run` et `/tmp` y sont des tmpfs vides (seul `/run/systemd/resolve` est remonté pour le DNS), avec un namespace PID et un `/proc` neufs. Landlock ne contrôle pas `connect()` sur les sockets Unix nommées : sans ce masquage, le code sandboxé atteindrait `/var/run/docker.sock` (l'utilisateur des runners hébergés par GitHub appartient au groupe `docker`), D-Bus ou `/run/user/<uid>`, et lirait `/proc/<pid>/environ` de l'orchestrateur. Les phases réseau (`https_only`, `proxy_only`) exécutent `landrun` dans ce namespace (backend `bubblewrap+landrun`) pour les règles de fichiers et de ports TCP. Chaque phase tourne dans son propre groupe de processus, tué à sa fin.
5. Une **Session d'agent** (`SandboxAgentSession`) reçoit un répertoire personnel éphémère sous `/tmp`, seul emplacement inscriptible avec le répertoire de travail. Ses dépendances sont installées avant la session, sous `https_only`, avant que le proxy et son nonce n'existent. Les chemins en lecture seule supplémentaires (moteur embarqué dans EPURE) sont déclarés explicitement.

## Alternatives écartées

- **Proxy générique vers une liste d'hôtes** : laisse l'agent atteindre n'importe quel chemin du fournisseur (fichiers, lots, fine-tuning) avec la clé du runner.
- **Garder l'activation par variable** : un repli silencieux sans confinement en CI reste possible par simple erreur de configuration.
- **Refuser de s'exécuter quand `docker.sock` existe** : tous les runners hébergés l'ont ; le masquer dans le namespace suffit.

## Conséquences

- `run-agent` exige l'entrée `model` ; un modèle sans clé sur le runner échoue avant de lancer la sandbox (`LLM_API_KEY_MISSING`). Sans `model`, `run-sandboxed` ne démarre pas de proxy et s'exécute hors ligne.
- Un runner CI sans `bubblewrap` fonctionnel ne peut plus rien exécuter ; sans `landrun`, plus de phase `proxy_only` ni `https_only`.
- `proxy_only` n'est pas une frontière contre l'exfiltration de données : `landrun` autorise le port du proxy vers n'importe quelle adresse IP, ne filtre pas UDP, et le fournisseur lui-même peut servir de relais. Il protège la clé, pas le contenu du dépôt (durcissement : #139, #140).
- Les outils qui écrivent dans `/tmp` sans respecter `TMPDIR` échouent dans une session d'agent confinée par `landrun`.
