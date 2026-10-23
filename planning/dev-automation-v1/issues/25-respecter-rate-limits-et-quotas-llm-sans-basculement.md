# 25: Respecter rate limits et quotas LLM sans basculement

**What to build:** Une erreur temporaire LLM entraîne une reprise bornée, alors qu’une clé invalide ou des crédits épuisés suspendent le ticket et l’indiquent sur GitHub.

**Blocked by:** 07 — Implémenter un premier ticket avec Pi

**Status:** ready-for-agent

- [ ] Un rate limit transitoire déclenche backoff et retries plafonnés, distincts des tentatives de correction de code.
- [ ] Une erreur de clé/quota/crédits suspend avec diagnostic exploitable.
- [ ] Aucune seconde clé ou provider n’est choisi automatiquement et aucun coût monétaire n’est calculé par dev-automation.

**Traçabilité :** user stories US-79, US-80 ; tests T-21.
