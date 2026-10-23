# 15: Détecter une spec devenue obsolète avant intégration

**What to build:** Un ticket conserve la version documentaire approuvée et signale si de nouvelles décisions rendent ses hypothèses incompatibles avant l’intégration.

**Blocked by:** 14 — Approuver un graphe précis sans autorisation illimitée

**Status:** ready-for-agent

- [ ] L’agent reçoit une référence documentaire immuable pour commencer son ticket.
- [ ] Une nouvelle décision contradictoire est détectée et bloque le ticket affecté, sans effacer sa référence initiale.
- [ ] Une évolution documentaire sans incompatibilité n’impose pas artificiellement une réapprobation.

**Traçabilité :** user stories US-29, US-30 ; tests T-7.
