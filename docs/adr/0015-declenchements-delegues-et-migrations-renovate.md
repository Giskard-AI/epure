---
status: accepted
---
# Poursuite automatique des plans approuvés et migrations Renovate

## Contexte

Les commandes d'agents initiées par une personne exigent la permission GitHub effective `write` ou supérieure (Q1, Q44). Cependant, un pipeline semi-automatisé doit pouvoir enchaîner les opérations autorisées sans nouveau commentaire humain à chaque étape. Par ailleurs, les PR Renovate peuvent nécessiter une adaptation du code lorsque la CI révèle une incompatibilité.

## Décision (Q46–Q47)

1. **Autorisation déléguée bornée (Q46).** Une approbation humaine du plan autorise les jobs et transitions prévus par celui-ci (création des tickets, implémentation, CI, review, publication et merge vers `feature/*` dans les cas autorisés). Un événement GitHub ultérieur émis par un workflow ou par notre GitHub App peut poursuivre automatiquement l'exécution **uniquement** si le contrôleur vérifie sa provenance, la référence du plan approuvé, les permissions de l'opération, les SHAs et l'état encore valide du plan. L'événement seul ne constitue jamais une nouvelle approbation ou une extension de périmètre.
2. **Migration Renovate optionnelle (Q47).** Si et seulement si une configuration du dépôt, déjà approuvée par un administrateur, active `auto_migrate`, une PR de dépendances Renovate dont la CI échoue peut déclencher un agent de migration. Il consulte les notes de version et la documentation de migration et propose des corrections sur la branche de la PR, sans intégrer lui-même les changements à `dev`.
3. Toute PR Renovate vers `dev` requiert une approbation humaine avant le merge (Q12, Q45), même si l'agent obtient ensuite une CI et une review IA positives.
4. Les règles de Q5, Q9, Q31 et Q44 restent obligatoires : aucun secret privilégié dans les tests/code non fiables, pas de merge automatique de changement sensible, pas de délégation autonome de permissions supplémentaires. Une PR externe, un commentaire ou un payload d'événement non vérifié ne peuvent usurper l'autorisation d'un plan ou de Renovate.
5. Le cas particulier de la **vérification d'identité de la PR Renovate** (compte/app et propriété de la branche) et les déclencheurs exacts font partie des spécifications à élaborer, pas d'une autorisation implicite de toutes les PR ayant échoué.

## Conséquences

- Les enchaînements issus d'une approbation sont automatisables sans faire porter des droits `write` aux comptes techniques comme si c'étaient des personnes.
- Le parcours Renovate peut corriger des migrations cassantes, tout en conservant le contrôle humain sur l'intégration vers `dev`.
- L'orchestrateur doit stocker des relations d'autorisation et des références Git stables, et valider chaque transition avant publication.
