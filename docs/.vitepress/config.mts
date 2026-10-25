import { defineConfig } from "vitepress";

const basePath = process.env.VITEPRESS_BASE ?? "/epure/";

export default defineConfig({
  title: "EPURE",
  description:
    "Engineered Planning, Unified Review & Execution — GitHub-First Specification-Driven Software Engineering Framework",
  base: basePath,
  cleanUrls: true,
  head: [
    ["link", { rel: "icon", type: "image/x-icon", href: `${basePath}favicon.ico` }],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: `${basePath}favicon-32x32.png`,
        media: "(prefers-color-scheme: light)"
      }
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: `${basePath}favicon-dark-32x32.png`,
        media: "(prefers-color-scheme: dark)"
      }
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: `${basePath}favicon-16x16.png`
      }
    ],
    [
      "link",
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: `${basePath}apple-touch-icon.png`
      }
    ],
    ["meta", { property: "og:image", content: `${basePath}og-image.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }]
  ],
  srcExclude: [
    "archify/**/*.json",
    "agents/**/*.md",
    "specs/**/*.md",
    "adr/**/*.md",
    "DECISIONS.md",
    "CONTRACTS.md"
  ],
  themeConfig: {
    logo: {
      light: "/logo-navbar-light.png",
      dark: "/logo-navbar-dark.png",
      alt: "EPURE Logo"
    },
    search: {
      provider: "local"
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/Giskard-AI/epure" }
    ]
  },
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      title: "EPURE",
      description:
        "Engineered Planning, Unified Review & Execution — Specification-Driven GitHub Engineering",
      themeConfig: {
        nav: [
          { text: "Philosophy & Intro", link: "/introduction" },
          { text: "Installation", link: "/installation" },
          { text: "Basic Usage", link: "/basic-usage" },
          { text: "Commands", link: "/commands" },
          { text: "Configuration", link: "/configuration" },
          {
            text: "How-To Guides",
            items: [
              { text: "Onboard with /setup-repo", link: "/guides/how-to-onboard-repo" },
              { text: "Drive an Issue End-to-End", link: "/guides/how-to-drive-an-issue" },
              {
                text: "Customize Reviewers & Impeccable",
                link: "/guides/how-to-customize-reviewers"
              },
              { text: "Promote a Release (dev -> main)", link: "/guides/how-to-release" }
            ]
          },
          { text: "Architecture & Glossary", link: "/architecture" }
        ],
        sidebar: [
          {
            text: "Philosophy & Getting Started",
            items: [
              { text: "Introduction & Naming (L'Épure)", link: "/introduction" },
              { text: "Installation & /setup-repo Skill", link: "/installation" },
              { text: "Basic Usage (Case Study)", link: "/basic-usage" }
            ]
          },
          {
            text: "Skills, CLI & Configuration",
            items: [
              { text: "Commands (/epure & /setup-repo)", link: "/commands" },
              { text: "The .github/agents.yml File", link: "/configuration" }
            ]
          },
          {
            text: "Practical Guides (How-To)",
            items: [
              { text: "Onboard a Repository", link: "/guides/how-to-onboard-repo" },
              { text: "Drive an Issue End-to-End", link: "/guides/how-to-drive-an-issue" },
              {
                text: "Customize Reviewers & Impeccable",
                link: "/guides/how-to-customize-reviewers"
              },
              { text: "Promote a Release (dev -> main)", link: "/guides/how-to-release" }
            ]
          },
          {
            text: "Architecture & Ubiquitous Language",
            items: [
              { text: "Security & Multi-Agent Review", link: "/architecture" },
              { text: "Domain Glossary (EN / FR)", link: "/reference/glossary" }
            ]
          }
        ],
        footer: {
          message: "Released under the Apache-2.0 License.",
          copyright: "Copyright © Giskard-AI — EPURE"
        }
      }
    },
    fr: {
      label: "Français",
      lang: "fr-FR",
      link: "/fr/",
      title: "EPURE",
      description:
        "Élaboration de Plans, Usinage, Revue et Exécution — Ingénierie Logicielle Gouvernée sur GitHub",
      themeConfig: {
        nav: [
          { text: "Philosophie & Intro", link: "/fr/introduction" },
          { text: "Installation", link: "/fr/installation" },
          { text: "Usage de Base", link: "/fr/basic-usage" },
          { text: "Commandes", link: "/fr/commands" },
          { text: "Configuration", link: "/fr/configuration" },
          {
            text: "Guides Pratiques",
            items: [
              { text: "Onboarder avec /setup-repo", link: "/fr/guides/how-to-onboard-repo" },
              {
                text: "Piloter une Issue de Bout en Bout",
                link: "/fr/guides/how-to-drive-an-issue"
              },
              {
                text: "Personnaliser le Roster & Impeccable",
                link: "/fr/guides/how-to-customize-reviewers"
              },
              {
                text: "Promouvoir une Release (dev -> main)",
                link: "/fr/guides/how-to-release"
              }
            ]
          },
          { text: "Architecture & Glossaire", link: "/fr/architecture" }
        ],
        sidebar: [
          {
            text: "Philosophie & Prise en Main",
            items: [
              { text: "Introduction & Nom (L'Épure)", link: "/fr/introduction" },
              { text: "Installation & Skill /setup-repo", link: "/fr/installation" },
              { text: "Usage de Base (Étude de Cas)", link: "/fr/basic-usage" }
            ]
          },
          {
            text: "Skills, CLI & Configuration",
            items: [
              { text: "Commandes (/epure & /setup-repo)", link: "/fr/commands" },
              { text: "Le Fichier .github/agents.yml", link: "/fr/configuration" }
            ]
          },
          {
            text: "Guides Pratiques (How-To)",
            items: [
              { text: "Onboarder un Dépôt", link: "/fr/guides/how-to-onboard-repo" },
              {
                text: "Piloter une Issue de Bout en Bout",
                link: "/fr/guides/how-to-drive-an-issue"
              },
              {
                text: "Personnaliser le Roster & Impeccable",
                link: "/fr/guides/how-to-customize-reviewers"
              },
              {
                text: "Promouvoir une Release (dev -> main)",
                link: "/fr/guides/how-to-release"
              }
            ]
          },
          {
            text: "Architecture & Langage Ubiquitaire",
            items: [
              { text: "Architecture, Sécurité & Revue", link: "/fr/architecture" },
              { text: "Glossaire du Domaine", link: "/fr/reference/glossary" }
            ]
          }
        ],
        footer: {
          message: "Distribué sous licence Apache-2.0.",
          copyright: "Copyright © Giskard-AI — EPURE"
        }
      }
    }
  }
});
