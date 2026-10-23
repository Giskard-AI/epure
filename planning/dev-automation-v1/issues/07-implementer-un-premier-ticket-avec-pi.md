# 07: Implémenter un premier ticket avec Pi

**What to build:** Sur un ticket de démonstration approuvé, Pi lit les critères du ticket, produit un changement de code et obtient une PR sur la branche de travail sans détenir de credential d’écriture.

**Blocked by:** 04 — Initialiser et reconfigurer un dépôt avec setup-repo; 06 — Bloquer la lecture de credentials depuis du code non fiable

**Status:** ready-for-agent

- [ ] Le moteur Pi s’exécute sans interaction terminale sur le runner du dépôt appelant.
- [ ] Le résultat est normalisé en artifacts structurés et vérifié avant publication.
- [ ] Une PR reliée au ticket est produite via le publisher, sans écritures directes de l’agent sur dev ou main.
- [ ] Le chemin est testé de bout en bout avec un modèle ou fournisseur de test reproductible.

**Traçabilité :** user stories US-48, US-51 ; tests T-10.
