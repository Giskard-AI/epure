# 22: Libérer les tickets dépendants sur résolution prouvée

**What to build:** Après merge d’un ticket, le système recalcule les relations GitHub et ne lance que les tickets dont tous les bloqueurs sont réellement satisfaits.

**Blocked by:** 18 — Merger automatiquement un ticket ordinaire sans course

**Status:** ready-for-agent

- [ ] Un merge lié à une issue débloque les tâches dont toutes les dépendances sont satisfaites.
- [ ] Fermer une issue comme abandonnée, en doublon ou sans preuve de résolution ne débloque pas ses dépendants.
- [ ] Une réconciliation périodique restitue le même état si l’événement de merge a été manqué.

**Traçabilité :** user stories US-69, US-70, US-71, US-72, US-75 ; tests T-6, T-18.
