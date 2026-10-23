# 13: Transformer une spec en sous-issues dépendantes

**What to build:** Une issue de planification aboutit à une spec et à un ensemble de tickets vérifiables individuellement, liés par les relations natives parent/enfant et bloqué-par de GitHub.

**Blocked by:** 12 — Versionner les décisions proposées et leur état effectif

**Status:** ready-for-agent

- [ ] La spec et les critères d’acceptation sont lisibles avant toute approbation d’implémentation.
- [ ] Chaque ticket décrit une tranche verticale testable et référence ses dépendances natives, sans graphe privé concurrent.
- [ ] Le graphe est acyclique, les tickets sans bloqueur sont reconnaissables et aucun ticket ne démarre encore.
- [ ] Une relecture humaine peut modifier le découpage avant autorisation.

**Traçabilité :** user stories US-31, US-69 ; tests T-5.
