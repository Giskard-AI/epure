# 03: Installer deux GitHub Apps à rôles distincts

**What to build:** Un mainteneur équipe un dépôt consommateur de sa propre Agent App et Release App avec des permissions séparées, et vérifie qu’une identité de développement ne peut pas exercer le pouvoir de publication de release.

**Blocked by:** 02 — Répondre à une commande d’issue autorisée

**Status:** ready-for-agent

- [ ] L’assistant guide la création/installation des deux Apps, sans afficher leur clé privée dans une issue ou un prompt.
- [ ] Un contrôle démontre que l’Agent App peut publier un commentaire autorisé mais pas pousser une release.
- [ ] La Release App reste inaccessible aux agents ordinaires et est limitée au chemin de publication protégé.
- [ ] Toute opération d’octroi de permission élevée requiert une confirmation humaine explicite.

**Traçabilité :** user stories US-8, US-9, US-10, US-97 ; tests T-8, T-31.
