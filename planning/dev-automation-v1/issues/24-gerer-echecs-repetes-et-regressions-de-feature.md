# 24: Gérer échecs répétés et régressions de feature

**What to build:** Un ticket dont les corrections n’aboutissent pas est escaladé ; si une régression apparaît après un merge, la feature est gelée et un correctif est suivi sans réécriture d’historique.

**Blocked by:** 22 — Libérer les tickets dépendants sur résolution prouvée

**Status:** ready-for-agent

- [ ] Au plus trois cycles de correction de code infructueux entraînent needs-human ; les tickets indépendants continuent.
- [ ] Une régression après intégration suspend les futurs merges de la feature.
- [ ] Une issue corrective est créée avec les observations de la régression, sans force-push de l’historique partagé.

**Traçabilité :** user stories US-67, US-68, US-78 ; tests T-17, T-20.
