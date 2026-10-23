---
status: accepted
---
# Séparer les agents exécutants des écritures GitHub privilégiées

Les agents peuvent exécuter des outils et du code issus d'un dépôt ou de dépendances non fiables ; leur donner en même temps des identifiants GitHub en écriture élargirait inutilement l'impact d'une compromission. Nous séparons donc les phases d'exécution et de test des opérations GitHub privilégiées : l'exécuteur ne reçoit aucun token d'écriture, tandis qu'un éditeur dédié n'applique que des opérations validées, grâce à un token d'installation temporaire à permissions réduites. Les tests de code non fiable restent isolés des secrets et des privilèges ; la distribution d'accès au LLM doit également éviter de les exposer au code testé.

Ce cloisonnement ajoute une étape explicite de validation et de publication, en échange d'une réduction de l'autorité accordée aux agents et de la surface d'exfiltration.

## Frontière des contributions publiques — Q44

Seuls les utilisateurs dont la permission GitHub effective est `write` ou supérieure sur le **dépôt cible** peuvent demander le déclenchement d'agents, approuver des plans ou relancer des opérations privilégiées (confirmation de Q1). La vérification est faite à chaque transition sensible via l'API GitHub, pas à partir de `author_association` ni d'un label. Les contributions externes restent possibles au moyen d'issues/PR ordinaires, avec CI sans secrets privilégiés ; leur contenu est une donnée non fiable et ne commande jamais l'agent de lui-même. Le fait d'avoir déjà contribué au dépôt ne suffit pas.
