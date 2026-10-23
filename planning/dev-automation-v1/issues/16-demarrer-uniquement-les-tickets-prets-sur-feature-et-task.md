# 16: Démarrer uniquement les tickets prêts sur feature et task

**What to build:** Une feature approuvée démarre automatiquement ses tickets indépendants sur leurs branches task, tandis que les tickets dépendants attendent une résolution satisfaisante de leurs bloqueurs.

**Blocked by:** 07 — Implémenter un premier ticket avec Pi; 15 — Détecter une spec devenue obsolète avant intégration

**Status:** ready-for-agent

- [ ] Une feature possède sa propre base et chaque ticket actif produit une branche de travail et une PR associée.
- [ ] Les tickets sans bloqueur peuvent s’exécuter en parallèle ; les bloqués ne consomment pas de run d’agent.
- [ ] Aucune tâche ne démarre après annulation, retrait d’autorisation ou divergence de sa spec approuvée.

**Traçabilité :** user stories US-48, US-49, US-70 ; tests T-6.
