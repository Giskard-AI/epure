---
status: superseded
---
# Encadrer l'autonomie par des limites d'essais et l'escalade humaine (superseded)

> Remplacé par [ADR-0012](0012-controle-operationnel-et-facturation-llm-externalisee.md). Les limites techniques restent applicables ; les budgets financiers dans `dev-automation` ont été abandonnés après Q30.

Après approbation du plan, les agents peuvent traiter automatiquement les tickets éligibles sans nouvelle validation de chaque ticket ordinaire. Chaque ticket est limité à trois tentatives de correction après échec, dans la limite d'un budget LLM global. Au-delà, le ticket passe en `needs-human` ; ses dépendants restent bloqués et les tickets indépendants peuvent continuer. Les corrections internes au périmètre approuvé ne requièrent pas de revalidation, à la différence des changements significatifs d'exigences, d'architecture ou de dépendances.

Ce cadre évite les boucles coûteuses et les élargissements implicites du mandat donné aux agents.

L'enveloppe de travail autonome comprend un plafond de consommation par ticket, un plafond cumulé par fonctionnalité et une limite de concurrence. Atteindre l'un des plafonds suspend l'exécution concernée jusqu'à une nouvelle décision humaine ; aucune dépense additionnelle n'est engagée implicitement.
