---
status: accepted
---
# Licence Apache-2.0 et attribution des composants tiers

## Contexte

`dev-automation` distribue des Reusable Workflows, des Custom Actions, des skills et des bibliothèques d'orchestration comme projet open source. Des composants externes peuvent être adaptés ou embarqués ; leurs licences ne sont pas nécessairement identiques.

## Décision (Q56)

- Publier les composants **originaux** de `dev-automation` sous la licence **Apache-2.0**.
- Autoriser librement les utilisations dans des dépôts privés, publics et commerciaux sans imposer aux consommateurs de republier leur code sous Apache-2.0.
- Conserver les licences, mentions de copyright et fichiers `NOTICE` applicables aux fichiers tiers copiés, modifiés ou redistribués.
- En particulier, préserver les exigences MIT des skills repris de [Matt Pocock](https://github.com/mattpocock/skills), et celles d'Apache-2.0 pour les composants effectivement repris d'[iFixAi](https://github.com/ifixai-ai/iFixAi) et d'[Impeccable](https://github.com/pbakaus/impeccable), selon les révisions incorporées.
- Fournir un inventaire des contenus tiers effectivement redistribués, de leurs versions et de leurs avis applicables. Les dépendances utilisées à l'exécution mais non redistribuées sont suivies séparément.

## Conséquences

- Le dépôt comportera un `LICENSE` Apache-2.0 pour son code original, et, selon les contenus repris, un fichier `NOTICE` et des textes de licences tierces appropriés.
- Un changement de licence amont, de contenu repris ou d'étendue de distribution déclenche une nouvelle revue de conformité.
- Les contributions originales seront reçues sous les conditions de contribution du projet, à définir dans `CONTRIBUTING.md` ; ne pas supposer qu'Apache-2.0 règle à lui seul toutes les questions de droits sur les contributions.

## Références

Décisions Q42–Q43 et Q56 ; ADR-0008, ADR-0019.
