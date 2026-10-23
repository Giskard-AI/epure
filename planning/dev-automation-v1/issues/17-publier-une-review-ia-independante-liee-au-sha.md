# 17: Publier une review IA indépendante liée au SHA

**What to build:** Une PR de ticket reçoit une review par un second agent lisant spec, diff et checks, dont le verdict est publié comme GitHub Check sur la révision exacte.

**Blocked by:** 16 — Démarrer uniquement les tickets prêts sur feature et task

**Status:** ready-for-agent

- [ ] Le reviewer a une session propre, n’accède pas au raisonnement de l’implementer et ne peut ni pousser ni merger.
- [ ] Le check ai-review est émis pour le SHA effectivement analysé, avec remarques actionnables sur la PR.
- [ ] Un nouveau commit humain ou agent invalide l’ancien verdict et impose une nouvelle review.

**Traçabilité :** user stories US-54, US-55, US-56, US-63 ; tests T-12, T-15.
