# 21: Intégrer une feature terminée à dev avec review humaine

**What to build:** Quand tous les tickets obligatoires sont achevés, une feature est présentée en PR vers dev, avec CI intégrée et approbation humaine obligatoire.

**Blocked by:** 19 — Autoriser une base en retard uniquement si l’intégration est saine; 20 — Retenir les changements sensibles pour une approbation humaine

**Status:** ready-for-agent

- [ ] Une feature incomplète ne peut ouvrir qu’une draft PR, même si les tickets terminés passent leurs checks.
- [ ] La feature récupère les changements récents de dev et valide le résultat combiné avant intégration.
- [ ] Un utilisateur autorisé effectue une véritable review GitHub avant le merge vers dev.
- [ ] La documentation approuvée rejoint dev et les modifications non approuvées restent hors du merge.

**Traçabilité :** user stories US-64, US-65, US-66 ; tests T-16.
