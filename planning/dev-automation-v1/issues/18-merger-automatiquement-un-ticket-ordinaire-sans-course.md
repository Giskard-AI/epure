# 18: Merger automatiquement un ticket ordinaire sans course

**What to build:** Deux PR de tickets ordinaires validées pour une même feature sont intégrées l’une après l’autre, seulement si l’état combiné reste vert.

**Blocked by:** 17 — Publier une review IA indépendante liée au SHA

**Status:** ready-for-agent

- [ ] Les required checks et ai-review verts sont vérifiés sur l’état effectivement intégré.
- [ ] Une seule intégration vers la feature est active à la fois ; une seconde PR est revalidée contre la nouvelle cible.
- [ ] GitHub Merge Queue est utilisée lorsque possible, avec mécanisme de repli sur les autres dépôts publics.
- [ ] Le merge ne provoque aucune écriture directe sur dev ou main.

**Traçabilité :** user stories US-50, US-59, US-60, US-61 ; tests T-11, T-14.
