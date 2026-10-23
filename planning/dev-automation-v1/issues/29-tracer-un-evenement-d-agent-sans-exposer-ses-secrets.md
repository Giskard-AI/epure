# 29: Tracer un événement d’agent sans exposer ses secrets

**What to build:** Un mainteneur retrouve les identifiants, décisions d’autorisation, agent, modèle et version de workflow d’une opération, sans avoir accès aux credentials ou au raisonnement privé.

**Blocked by:** 05 — Publier une proposition d’agent sans lui céder le token

**Status:** ready-for-agent

- [ ] Une commande autorisée et refusée émet une trace structurée vérifiable.
- [ ] Un commentaire/une PR associe rôle, modèle, version et lien du run.
- [ ] Les traces omettent secrets, prompts privés et valeurs sensibles ; leur durée de conservation est configurable et limitée.

**Traçabilité :** user stories US-88, US-89 ; tests T-8.
