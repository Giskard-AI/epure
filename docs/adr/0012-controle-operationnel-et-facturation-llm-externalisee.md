---
status: accepted
supersedes: 0003
---
# Externaliser la facturation LLM et conserver les garde-fous opérationnels

## Contexte

La question Q13 avait initialement approuvé un budget financier par ticket et par fonctionnalité, puis Q30 a rejeté une comptabilité des coûts stockée dans GitHub. L'utilisateur a clarifié que les prix, crédits, plafonds de dépense et autres contrôles financiers sont exclusivement gérés au niveau des fournisseurs LLM et de leurs clés API, lorsqu'ils proposent ces fonctions.

## Décision

1. `dev-automation` **ne calcule, ne stocke et ne fait respecter aucun budget monétaire LLM** : ni prix, ni coût des tokens, ni compteur financier par ticket, fonctionnalité, dépôt ou organisation. Les workflows et Custom Actions n'implémentent pas de facturation interne.
2. Les utilisateurs configurent chez leur **fournisseur LLM** les quotas, crédits et limites financières liés aux comptes ou clés API, selon les options disponibles. Le skill `setup-repo` peut expliquer comment renseigner les clés dans GitHub Secrets, mais ne prétend pas imposer une limite monétaire côté workflow.
3. Les **garde-fous opérationnels** restent dans `dev-automation` : au plus trois tentatives de correction par ticket avant `needs-human`, limites de concurrence, durée maximale des jobs/commandes, gestion d'erreurs et arrêt des tâches annulées. Les autres tickets indépendants peuvent poursuivre.
4. En cas de limitation temporaire (`429`, temporisation indiquée par le fournisseur), les appels peuvent être réessayés avec délai progressif et un nombre limité de répétitions. En cas de clé invalide, de crédits épuisés ou de quota bloquant, suspendre les tâches qui dépendent de cette API et signaler explicitement l'échec dans GitHub. **Ne jamais basculer automatiquement sur une autre clé ou un autre fournisseur**, car cela pourrait contourner une limite financière volontaire. Les reprises d'appels transitoires sont distinctes des trois tentatives de correction de code par ticket (Q8).
5. Une limite financière **n'est pas garantie** si le fournisseur ne propose pas de plafond dur ou s'il traite la limite de manière asynchrone.
6. Cette décision **remplace** la dimension budgétaire de Q13 et toute formulation antérieure suggérant un compteur ou une suspension pour dépassement de budget financier interne.

## Conséquences

- Pas de persistance de coûts dans GitHub ; pas de base externe ni de service financier.
- La visibilité financière reste celle des tableaux de bord / API des fournisseurs, hors périmètre du MVP.
- Les timeouts et limites de tentatives encadrent l'exécution mais ne garantissent pas un coût maximum.
