# 02: Répondre à une commande d’issue autorisée

**What to build:** Un utilisateur disposant de la permission effective write lance une commande de diagnostic depuis une issue et reçoit une réponse GitHub ; un lecteur, un label ou un bot ne peuvent pas déclencher cette opération.

**Blocked by:** 01 — Consommer un workflow et une action publics

**Status:** ready-for-agent

- [ ] Une commande d’un utilisateur write ou admin est acceptée après vérification de sa permission effective via GitHub.
- [ ] Une commande d’un utilisateur read/triage, un rôle affiché ou un label trompeur ne provoque ni action privilégiée ni appel LLM.
- [ ] Les commentaires des bots sont ignorés comme demandes humaines et ne créent aucune boucle.
- [ ] Le résultat et le refus sont consultables depuis l’issue ou les checks sans divulguer de token.

**Traçabilité :** user stories US-16, US-17, US-18, US-23 ; tests T-1, T-2.
