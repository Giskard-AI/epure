# 05: Publier une proposition d’agent sans lui céder le token

**What to build:** Un agent de démonstration propose une modification ou un commentaire ; un publisher isolé valide cette demande et l’applique avec un token d’installation temporaire et restreint.

**Blocked by:** 03 — Installer deux GitHub Apps à rôles distincts

**Status:** ready-for-agent

- [ ] Le job agent ne reçoit aucune écriture GitHub et ne connaît pas la clé privée de l’App.
- [ ] Le publisher refuse une opération hors périmètre, mal formée ou destinée à une branche protégée.
- [ ] La proposition valide produit un commit/une PR ou un commentaire vérifiable, sans donner le token au processus agent.
- [ ] Un token d’installation est limité au dépôt, aux permissions utiles et à la durée de publication.

**Traçabilité :** user stories US-53 ; tests T-8, T-9.
