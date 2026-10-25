---
layout: home

hero:
  name: "EPURE"
  text: "Specification-Driven GitHub Engineering"
  tagline: "Engineered Planning, Unified Review & Execution — Draw the architectural blueprint with a human maintainer before agents machine, test, and review the code."
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: EPURE — Blueprint Geometry & Network Convergence
  actions:
    - theme: brand
      text: Read the Introduction
      link: /introduction
    - theme: alt
      text: Basic Usage (Case Study)
      link: /basic-usage
    - theme: alt
      text: Documentation Française
      link: /fr/

features:
  - title: "1. The Blueprint First (Grill -> Spec -> DAG)"
    details: "Comment /epure plan on a GitHub Issue. EPURE conducts a structured design interview, writes GLOSSARY.md, ADRs, and a complete Specification on plan/*, and decomposes the work into a dependency-ordered ticket DAG."
  - title: "2. Four Mandatory Human Gates"
    details: "Humans retain sovereign authority at 4 explicit gates: initiating & answering the Grill, signing the plan mandate with /epure approve (spec_sha), merging the final feature/* -> dev PR, and triggering production releases."
  - title: "3. Secretless TDD & Trusted dev Review"
    details: "Tickets execute inside a secretless sandbox (0 API keys or App PEMs in subprocesses), audited by up to 4 domain-specialized reviewers loaded strictly from trusted dev, plus Impeccable WCAG AA UI gates."
  - title: "4. Dual-App Governance & CAS State"
    details: "Out-of-branch atomic state in refs/epure/state/<issue> avoids commit noise on dev. Two dedicated GitHub Apps (Agent App vs. Release App) and 3 Repository Rulesets enforce strict privilege separation."
---

## Interactive Overview: Global Issue & PR Flow

Every EPURE workflow follows a strict tripartition between **Mandatory Human Validation Gates**, **Mandatory Automated Pipeline Steps**, and **Optional / Conditional Steps**:

<ArchifyDiagram
  slug="epure-issue-flow"
  locale="en"
  title="EPURE Global Issue & PR Flow (Human Gates, Mandatory & Conditional Steps)"
  caption="Interactive Archify showcase diagram — click any node or lane to inspect its role, or open in fullscreen."
/>
