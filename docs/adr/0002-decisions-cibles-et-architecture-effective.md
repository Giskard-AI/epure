---
status: accepted
---
# Distinguer les décisions architecturales acceptées de l'architecture effective

Les décisions architecturales peuvent être acceptées et intégrées à `dev` avant que leur implémentation n'existe. Chaque ADR décrit une décision cible, tandis que la documentation de l'architecture effective décrit ce qui existe réellement dans une révision donnée du code. Les propositions évoluent dans des branches de planification, sont validées via PR vers `dev`, puis leur référence approuvée sert de contexte aux tâches d'implémentation. `main` reçoit les ADR acceptés uniquement lors d'une release par fast-forward depuis `dev`. Le dépôt GitHub est l'unique source documentaire de vérité ; Wiki ou site documentaire externe ne font pas partie du MVP.

Ce choix préserve un historique cohérent des décisions, même pendant la transition d'une architecture vers une autre. Un changement significatif de décision, de spécification ou de dépendances après approbation suspend les travaux concernés jusqu'à nouvelle validation humaine.
