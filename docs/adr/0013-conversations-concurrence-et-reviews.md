---
status: accepted
---
# Conversations versionnées, traitement ordonné et review liée aux révisions

## Contexte

Les entretiens et implémentations s'étalent sur plusieurs runs GitHub Actions éphémères ; plusieurs commentaires peuvent arriver pendant une exécution et les branches de fonctionnalités peuvent évoluer en parallèle. Il faut conserver un état reprenable et empêcher les validations périmées.

## Décisions

1. **Q34 — Persistance de plan** : les commentaires GitHub forment l'interface de dialogue, mais `plan/*` conserve glossaire, ADR proposés, décisions et état compact de la session. Les validations humaines précèdent la publication documentaire sur `dev`.
2. **Q35 — Concurrence par issue** : au plus une exécution active par issue ; événements entrants traités en ordre vérifiable, avec déduplication et reprise idempotente. Les issues distinctes sont parallélisables.
3. **Q36 — Review et base obsolète** : chaque review IA est liée au SHA source exact ainsi qu'au diff effectivement revu. Tout changement de contenu nécessite une nouvelle review. Les dépôts choisissent `strict` (par défaut) ou `relaxed` pour l'avancement seul de la cible. `relaxed` ne permet un merge sur base en retard que si le diff approuvé reste identique, qu'aucun conflit n'existe et que la CI requise passe sur le résultat **combiné** avec la dernière tête de destination. Avant publication, l'orchestrateur vérifie que les SHA source, destination et SHA testé correspondent encore ; autrement il invalide le résultat et recommence. Les protections GitHub, leurs règles sur les reviews périmées et les approbations humaines priment toujours.
4. **Q37 — Traçabilité** : publier dans GitHub l'identité logique/role de l'agent, le modèle, la version exacte de `dev-automation` et le lien vers le run pour les commentaires, PR et reviews. Ne pas publier de secrets ou de prompts sensibles.

## Conséquences

- Distinction explicite entre une review du **code proposé** et un check d'**intégration sur un résultat combiné**.
- Une absence de conflit Git n'est pas une garantie de compatibilité ; le check sur le merge résultat est indispensable dans le mode `relaxed`.
- GitHub Merge Queue peut fournir ces vérifications lorsque le dépôt et son plan la prennent en charge, sinon l'orchestrateur doit sérialiser et vérifier l'intégration sans contourner les protections.
- Le calcul exact de l'identité de diff approuvé et le stockage minimal des identifiants de run seront spécifiés durant l'implémentation.
