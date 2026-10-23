# 30: Auditer les autorisations de l’orchestrateur avec iFixAi

**What to build:** Une PR modifiant les mécanismes de permissions ou de délégation est bloquée si l’audit déterministe iFixAi échoue sur les trajectoires de référence.

**Blocked by:** 29 — Tracer un événement d’agent sans exposer ses secrets; 28 — Faire échouer une CI sur un workflow vulnérable selon zizmor

**Status:** ready-for-agent

- [ ] Une trace avec escalade de permission interdite fait échouer le check d’audit.
- [ ] Une trace valide passe sans consommer de tokens LLM.
- [ ] Les tests adversariaux LLM peuvent être lancés explicitement, sans être requis pour chaque PR applicative.
- [ ] La Custom Action d’audit est utilisable directement par un autre projet.

**Traçabilité :** user stories US-87, US-90 ; tests T-25.
