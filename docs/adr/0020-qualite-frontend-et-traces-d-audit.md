---
status: accepted
---
# Qualité frontend obligatoire par défaut et audits de l’orchestrateur

## Contexte

Impeccable et iFixAi sont intégrés en V1 (ADR-0019). Leur activation et les obligations d’audit doivent être explicites, sans imposer des contrôles UI aux projets sans interface ni exposer de données sensibles.

## Décisions (Q59–Q61)

1. **Q59 — Impeccable** : le contrôle de qualité Impeccable est **activé et obligatoire par défaut** pour les dépôts ou projets frontend, comme check de CI requis pour les PR concernées. Un dépôt peut le **désactiver explicitement** dans sa configuration approuvée ; le comportement par défaut d’un projet backend sans interface ne comporte aucun contrôle UI. Cette règle amende le caractère facultatif général de Q57 / ADR-0019 ; la sévérité des constats bloquants doit être définie en spécification.
2. **Q60 — iFixAi** : un audit déterministe des traces/trajectoires est **obligatoire dans la CI de `dev-automation`** lorsqu’une PR touche aux autorisations, délégations ou transitions de l’orchestrateur. Les campagnes d’évaluation comportementale LLM restent optionnelles et déclenchables manuellement ou périodiquement.
3. **Q61 — Traces minimisées** : enregistrer les références de runs, événements, décisions d’autorisation et transitions utiles à l’audit, sans secrets ni publication systématique des conversations internes. Durée de rétention configurable et limitée par défaut, suivant les capacités GitHub et les contraintes du dépôt.

## Conséquences

- `setup-repo` reconnaît les projets frontend et installe le check Impeccable requis par défaut ; l’opt-out est intentionnel, traçable et issu d’une configuration approuvée.
- L’audit iFixAi doit recevoir des traces fiables et vérifiables de fixtures de sécurité, sans confondre rapport a posteriori et contrôle de permission en temps réel.
- L’archivage GitHub des traces doit contrôler contenu et durée de vie. Le format précis et la politique de sévérité restent des travaux de spécification.

## Références

Q9, Q31, Q38, Q55, Q57–Q61 ; ADR-0019.
