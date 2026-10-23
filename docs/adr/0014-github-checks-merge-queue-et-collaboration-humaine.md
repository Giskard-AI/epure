---
status: accepted
---
# Checks IA, intégration native et collaboration humaine

## Contexte

Le flux de développement semi-automatisé doit fournir des conditions de merge vérifiables et compatibles avec les protections de branche, sans bloquer les corrections manuelles des développeurs. Les avis IA ne sont pas équivalents aux approbations humaines.

## Décisions

1. **Q38 — GitHub Check `ai-review`** : le reviewer produit un check associé à la révision effectivement analysée, en plus de commentaires utiles sur la PR. Le merge automatique d'un ticket exige un verdict favorable encore valide pour la révision approuvée. Le check est publié par une identité GitHub App disposant de `checks: write` et identifiée explicitement dans les protections de branche ; ne pas accepter un check homonyme émis par une source tierce. Aucun avis IA ne remplace la validation humaine requise pour `feature/* → dev`.
2. **Q39 — Merges et intégration** : employer la GitHub Merge Queue si disponible et configurée pour la cible. Sinon, le contrôleur assure la sérialisation des publications, les vérifications d'identité des révisions, ainsi que les tests du résultat combiné avec la destination actuelle. Respecter les stratégies `strict` et `relaxed` de Q36 et les protections GitHub. La Merge Queue n'est notamment pas disponible pour tous les dépôts personnels publics : le repli fait partie du produit.
3. **Q40 — Commentaires modifiés** : pour les sessions de type `grill-with-docs`, seuls les nouveaux commentaires autorisés alimentent l'entretien. Les éditions de commentaires anciens ne rejouent pas les décisions. Toute correction passe par un nouveau commentaire, horodaté et traçable.
4. **Q41 — Intervention humaine dans une PR d'agent** : les contributeurs autorisés peuvent éditer les branches `task/*`. Chaque nouvelle révision invalide la CI et la review IA correspondantes, qui doivent être refaites avant merge automatique, avec inspection du nouveau SHA source et du résultat combiné selon la politique du dépôt.

5. **Q45 — Approbation humaine native** : l'intégration `feature/* → dev` requiert une review GitHub réellement approuvée par une personne habilitée conformément aux règles de protection du dépôt. Ni une commande `/agent approve`, ni une review d'agent, ni un check `ai-review` vert ne constituent cette approbation. Les contraintes natives (identité distincte de l'auteur si requise, review périmée, statut du diff) s'appliquent.

## Implications

- La protection des branches doit exiger le check **issu de l'Agent App autorisée**, et non seulement un nom de statut générique.
- Le verdict IA doit être lié au SHA et au diff exacts du code inspecté ; à chaque édition, les autorisations précédentes expirent.
- Les jobs distincts de review, CI et publication respectent l'isolation des secrets décidée en Q9 et Q31.
- Aucun bypass de protection GitHub n'est accordé pour compenser l'absence de Merge Queue native.
- La mise en œuvre devra documenter les droits GitHub App, les événements `merge_group` de CI lorsque Merge Queue est utilisée, et le comportement en cas de panne/retry d'un check.

## Références

- https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
