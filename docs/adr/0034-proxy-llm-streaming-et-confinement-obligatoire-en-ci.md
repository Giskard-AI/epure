---
status: accepted
---
# ADR-0034 : Proxy LLM inverse en streaming vers le seul fournisseur du ticket et confinement noyau obligatoire en CI

- **Statut** : Accepté
- **Date** : 2026-11-08
- **Décideurs** : Mainteneurs EPURE
- **ADR liées** : ADR-0011, ADR-0023, ADR-0029, ADR-0030 (remplace la dernière règle de sa décision 2)

## Contexte

Les moteurs agentiques de la v3 (Pi, puis Cursor) appellent eux-mêmes le modèle depuis la sandbox, en streaming, avec le SDK de chaque fournisseur. Le **Proxy LLM de sandbox** de l'ADR-0023 était un relais générique : il ne connaissait ni le fournisseur ni ses chemins, et l'ADR-0030 ne rendait le confinement noyau obligatoire que si `EPURE_ENFORCE_KERNEL_SANDBOX=true` était défini. Une variable oubliée ou écrasée suffisait donc à lancer du code non fiable sans Landlock ni namespaces sur un runner CI qui détient des clés.

## Décisions

1. Le proxy est un proxy inverse lié au fournisseur du modèle du ticket (`resolveProviderUpstream`) : il n'accepte que `POST` sur les chemins déclarés de ce fournisseur, exige le nonce éphémère à la place de la clé (en-tête d'authentification du SDK ou `?key=`), injecte la vraie clé dans l'en-tête attendu par le fournisseur, conserve la query string et relaie la réponse morceau par morceau (SSE). Le chemin de réponse expose un point d'observation (`observeResponse`) pour le futur décompte des jetons (#125).
2. En CI (`GITHUB_ACTIONS=true` ou `CI=true` dans l'environnement du runner), toute exécution sandboxée refuse de démarrer sans backend noyau utilisable pour chacune de ses phases (`SANDBOX_ISOLATION_UNAVAILABLE`). Aucune variable ne permet de désactiver cette règle ; `EPURE_ENFORCE_KERNEL_SANDBOX=true` ne sert plus qu'à l'exiger hors CI.
3. Une **Session d'agent** reçoit un répertoire personnel éphémère sous `/tmp`, seul emplacement inscriptible avec le répertoire de travail. Ses dépendances sont installées avant la session, sous `https_only`, avant que le proxy et son nonce n'existent. Les chemins en lecture seule supplémentaires (moteur vendu avec EPURE) sont déclarés explicitement.

## Alternatives écartées

- **Proxy générique vers une liste d'hôtes** : laisse l'agent atteindre n'importe quel chemin du fournisseur (fichiers, lots, fine-tuning) avec la clé du runner.
- **Garder l'activation par variable** : un repli silencieux sans confinement en CI reste possible par simple erreur de configuration.

## Conséquences

- `run-agent` exige l'entrée `model` ; un modèle sans clé sur le runner échoue avant de lancer la sandbox (`LLM_API_KEY_MISSING`).
- Un runner CI sans `landrun` fonctionnel ne peut plus exécuter de phase `proxy_only` ni `https_only` ; `bubblewrap` ne couvre que les phases `offline`.
- Les outils qui écrivent dans `/tmp` sans respecter `TMPDIR` échouent dans une session d'agent confinée par `landrun`.
