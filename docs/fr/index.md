---
layout: home

hero:
  name: "EPURE"
  text: "Ingénierie Logicielle Gouvernée sur GitHub"
  tagline: "Élaboration de Plans, Usinage, Revue et Exécution — Tracez l'épure architecturale avec un mainteneur humain avant que les agents n'usinent, testent et révisent le code."
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: EPURE — Fusion entre Géométrie et Réseau
  actions:
    - theme: brand
      text: Lire l'Introduction
      link: /fr/introduction
    - theme: alt
      text: Usage de Base (Étude de Cas)
      link: /fr/basic-usage
    - theme: alt
      text: English Documentation
      link: /

features:
  - title: "1. L'Épure Avant l'Usinage (Grill -> Spec -> DAG)"
    details: "Commentez /epure plan sur une issue GitHub. EPURE mène un entretien d'architecture structuré, rédige GLOSSARY.md, les ADRs et la Spécification sur plan/*, puis découpe le travail en un graphe orienté acyclique (DAG) de tickets."
  - title: "2. Quatre Portes Humaines Obligatoires"
    details: "L'humain conserve l'autorité souveraine sur 4 jalons explicites : lancement et réponses au Grill, signature du mandat /epure approve (spec_sha), fusion finale feature/* -> dev et déclenchement de la release vers main."
  - title: "3. TDD Sans Secret & Revue depuis dev"
    details: "Chaque ticket est codé en TDD dans une sandbox dépourvue de secrets (0 clé API ou PEM dans les sous-processus), audité par jusqu'à 4 reviewers spécialisés chargés depuis dev et validé par la porte UI Impeccable."
  - title: "4. Gouvernance à 2 Apps & État Git CAS"
    details: "État atomique hors-branches dans refs/epure/state/<issue> sans polluer dev. Deux GitHub Apps distinctes (Agent App vs Release App) et 3 Rulesets garantissent le moindre privilège."
---

## Vue d'Ensemble Interactive : Flux Global d'une Issue & PR

Chaque flux EPURE respecte une tripartition stricte entre **Portes de Validation Humaine Obligatoires**, **Étapes Automatisées Obligatoires** et **Étapes Facultatives ou Conditionnelles** :

<ArchifyDiagram
  slug="epure-issue-flow"
  locale="fr"
  title="Flux Global d'une Issue & PR EPURE (Portes Humaines, Obligatoire & Conditionnel)"
  caption="Schéma interactif Archify en qualité showcase — cliquez sur un nœud ou une voie pour inspecter ses détails, ou passez en plein écran."
/>
