# 20: Retenir les changements sensibles pour une approbation humaine

**What to build:** Une PR de ticket qui touche à la CI, aux privilèges, aux secrets ou à une migration destructrice n’est pas mergée automatiquement, même avec tous les checks verts.

**Blocked by:** 17 — Publier une review IA indépendante liée au SHA

**Status:** ready-for-agent

- [ ] La classification de sensibilité est évaluée côté politique/publisher, et non déterminée librement par l’agent.
- [ ] Les changements ordinaires conservent la possibilité d’auto-merge lorsque les protections sont satisfaites.
- [ ] Une PR sensible exige une approbation humaine conforme à la politique GitHub avant intégration.

**Traçabilité :** user stories US-62 ; tests T-11.
