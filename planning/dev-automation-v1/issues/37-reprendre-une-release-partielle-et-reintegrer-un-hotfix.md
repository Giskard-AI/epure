# 37: Reprendre une release partielle et réintégrer un hotfix

**What to build:** Une publication interrompue après le fast-forward reprend de manière idempotente ; un hotfix manuel sur main peut ensuite être réintégré dans dev sans casser les prochaines promotions.

**Blocked by:** 36 — Promouvoir dev vers main par fast-forward manuel

**Status:** ready-for-agent

- [ ] Un retry après promotion sans publication recrée seulement l’objet manquant et pas un second tag ou release.
- [ ] Un tag existant pour un autre SHA bloque explicitement l’opération.
- [ ] Une procédure guidée réintègre les commits du hotfix depuis main vers dev et préserve la relation d’ascendance utile à la prochaine release.

**Traçabilité :** user stories US-95, US-96 ; tests T-30.
