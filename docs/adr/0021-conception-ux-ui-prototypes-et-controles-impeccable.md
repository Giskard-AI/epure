---
status: accepted
---
# Parcours UX/UI, prototypes et contrôles Impeccable

## Contexte

Les plans de développement doivent être suffisamment explicites sur les interactions et la conception visuelle avant d'autoriser l'implémentation automatisée. Les projets frontend bénéficient des compétences de clarification de Matt Pocock et des outils de conception/contrôle d'Impeccable. Le parcours se déroule depuis une issue de pilotage et reste traçable dans Git.

## Décisions (Q62–Q65)

1. **Q62 — Entretien unifié** : une fonctionnalité frontend passe par `grill-with-docs`, puis une étape de cadrage UX/UI utilisant notamment Impeccable `shape`. Les deux étapes réutilisent les décisions connues et dialoguent via **la même issue GitHub** ; ne pas répéter des questions déjà résolues. La phase de conception s'inscrit avant finalisation du périmètre/tickets d'implémentation.
2. **Q63 — Prototype si besoin de lever une incertitude** : lorsqu’une question UX ou de conception ne peut être résolue fiablement par échange, le workflow peut produire un **prototype léger avec données fictives**, avant validation humaine, sur une branche `prototype/*` distincte (clarification Q72). Les captures et informations de prévisualisation sont référencées depuis l'issue de pilotage. Aucun prototype n’est imposé en fonction d’un seuil arbitraire de complexité (Q72). Les prototypes ne sont **jamais mergés automatiquement** dans `dev`.
3. **Q64 — Documents versionnés** : conserver `PRODUCT.md` (contexte produit), `DESIGN.md` (design system et conventions), `.impeccable/surfaces/*.md` (décisions par interface), `docs/specs/*.md` (comportements attendus et acceptation) et `docs/adr/*.md` (arbitrages durables) dans le dépôt Git. Les modifications proposées restent sur `plan/*` jusqu'à approbation ; elles sont intégrées à `dev` conformément à la stratégie documentaire.
4. **Q65 — Qualité bloquante définie** : Impeccable est **obligatoire par défaut sur les projets frontend** (Q59). Le check bloque une PR en présence de **nouvelles violations de règles définies comme bloquantes** ; les exceptions doivent être justifiées et configurées explicitement. Les jugements esthétiques subjectifs sont communiqués en review sans blocage automatique. Un dépôt peut désactiver l'intégration Impeccable par configuration approuvée.

## Conséquences

- Étendre le routage des skills selon la nature frontend du ticket et les besoins UX/UI.
- Préserver les décisions de design dans l'issue et les fichiers versionnés pour éviter que les phases de spécification et d'implémentation divergent.
- Distinguer le prototype exploratoire de la branche `feature/*` et des tickets d'implémentation ; aucun prototype non validé ne devient une fonctionnalité livrable.
- Produire des critères d'acceptation qui couvrent comportements, design, et problèmes bloquants objectivables.
- Q66–Q69 ont précisé les previews GitHub-first, l’interdiction de réutiliser le code exploratoire, les captures comparées optionnelles et la validation du plan après `to-tickets` (voir ADR-0022). Les modalités de publication Pages et de rétention restent ouvertes.

## Références

Q7, Q14, Q34, Q53, Q55, Q57, Q59, Q62–Q65 ; ADR-0002, ADR-0013, ADR-0019, ADR-0020.
