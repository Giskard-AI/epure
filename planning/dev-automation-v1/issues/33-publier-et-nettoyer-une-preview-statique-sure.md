# 33: Publier et nettoyer une preview statique sûre

**What to build:** Un responsable produit peut voir une preview HTML via GitHub Pages ou son hébergeur existant, uniquement après opt-in, et la preview expire sans exposer production ni données sensibles.

**Blocked by:** 32 — Prototyper une incertitude sans réutiliser le code exploratoire; 04 — Initialiser et reconfigurer un dépôt avec setup-repo

**Status:** ready-for-agent

- [ ] Sans consentement à Pages, seules les captures/artifacts sont utilisés.
- [ ] Une preview valide se consulte sous une origine isolée de la production et expire après 14 jours par défaut, valeur configurable.
- [ ] Une tentative de publication exposant secrets, données personnelles ou origine de production est refusée.
- [ ] Un hébergeur de preview existant peut être réutilisé sans exiger Pages.

**Traçabilité :** user stories US-40, US-41, US-42, US-43 ; tests T-27.
