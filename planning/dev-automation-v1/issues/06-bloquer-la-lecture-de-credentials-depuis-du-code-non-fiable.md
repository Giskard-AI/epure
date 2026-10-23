# 06: Bloquer la lecture de credentials depuis du code non fiable

**What to build:** Un agent exécutant une commande ou un test provenant du dépôt consommateur tourne dans un conteneur isolé sans secret dans ses variables d'environnement et interroge le modèle via le proxy/sidecar LLM local sur le runner ; le code ou les tests ne peuvent jamais lire les credentials LLM, GitHub ou release.

**Blocked by:** 05 — Publier une proposition d’agent sans lui céder le token

**Status:** ready-for-agent

- [ ] Un proxy/sidecar local sur le runner détient la clé LLM en mémoire pendant que l'agent et les sous-processus de test/build tournent dans un conteneur isolé sans secret dans `process.env`.
- [ ] Un test adversarial tente d’exfiltrer les clés et échoue dans la sandbox réelle.
- [ ] Les commandes de build/tests se terminent et leurs sorties utiles parviennent à l’agent hors des privilèges du publisher.
- [ ] Si le runner ne fournit pas l’isolation exigée, l’exécution échoue fermée (*fail-closed*) plutôt que de continuer avec des secrets exposés.

**Traçabilité :** user stories US-52 ; tests T-9 ; ADR-0004, ADR-0023.
