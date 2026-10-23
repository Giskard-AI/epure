# 34: Bloquer les nouvelles violations Impeccable sur une PR frontend

**What to build:** Une PR frontend reçoit un check Impeccable : les nouvelles violations couvrant le socle objectif par défaut (accessibilité vérifiable WCAG/ARIA/contraste/clavier, cassures de layout/overflow responsive, états obligatoires loading/error/empty manquants) ainsi que toutes les règles et tokens ajoutés dans `DESIGN.md` et `.impeccable/surfaces/*.md` bloquent le merge, alors que les remarques purement esthétiques restent informatives.

**Blocked by:** 04 — Initialiser et reconfigurer un dépôt avec setup-repo; 31 — Élaborer un design Impeccable dans l’entretien de planification

**Status:** ready-for-agent

- [ ] Une nouvelle violation bloquante (socle objectif par défaut ou règle ajoutée dans `DESIGN.md` / `.impeccable/surfaces/*.md`) produit un check rouge et un diagnostic actionnable.
- [ ] La baseline existante n’entraîne pas artificiellement l’échec pour des problèmes anciens inchangés.
- [ ] Un opt-out ou une exception approuvée et tracée est respecté.
- [ ] La Custom Action peut être utilisée isolément dans une CI frontend tierce.

**Traçabilité :** user stories US-45, US-46, US-47 ; tests T-24 ; ADR-0020, ADR-0021, ADR-0023.
