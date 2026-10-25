import { defineConfig, type HeadConfig } from "vitepress";

const basePath = process.env.VITEPRESS_BASE ?? "/epure/";
const siteOrigin = "https://giskard-ai.github.io";
const siteUrl = `${siteOrigin}${basePath}`;

const structuredDataJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  name: "EPURE",
  alternateName: [
    "Engineered Planning, Unified Review & Execution",
    "Élaboration de Plans, Usinage, Revue et Exécution"
  ],
  description:
    "Open-source GitHub-first specification-driven software engineering framework built on Reusable Workflows, TypeScript Custom Actions (Node.js 24 LTS), and AI Agent Skills.",
  url: siteUrl,
  codeRepository: "https://github.com/Giskard-AI/epure",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  programmingLanguage: ["TypeScript", "JavaScript", "YAML"],
  runtimePlatform: "Node.js 24 LTS / GitHub Actions",
  author: {
    "@type": "Organization",
    name: "Giskard AI",
    url: "https://github.com/Giskard-AI"
  }
});

export default defineConfig({
  title: "EPURE",
  description:
    "Engineered Planning, Unified Review & Execution — GitHub-First Specification-Driven Software Engineering Framework",
  base: basePath,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: siteUrl
  },
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
    [
      "link",
      {
        rel: "alternate",
        type: "text/plain",
        href: `${siteUrl}llms.txt`,
        title: "LLM Documentation Index (llms.txt)"
      }
    ],
    [
      "link",
      {
        rel: "alternate",
        type: "text/plain",
        href: `${siteUrl}llms-full.txt`,
        title: "LLM Full Documentation Corpus (llms-full.txt)"
      }
    ],
    ["meta", { property: "og:site_name", content: "EPURE" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:image", content: `${siteUrl}og-image.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    [
      "meta",
      {
        property: "og:image:alt",
        content: "EPURE — Engineered Planning, Unified Review & Execution"
      }
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${siteUrl}og-image.png` }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "EPURE, GitHub Actions, AI Coding Agents, Specification-Driven Engineering, TDD Sandbox, Multi-Agent Code Review, Impeccable, Archify, Matt Pocock Skills, Giskard AI"
      }
    ],
    ["meta", { name: "robots", content: "index, follow, max-image-preview:large" }],
    ["script", { type: "application/ld+json" }, structuredDataJsonLd]
  ],
  transformHead({ pageData }) {
    const relPath = pageData.relativePath
      .replace(/(?:^|\/)index\.md$/, "")
      .replace(/\.md$/, "");
    const cleanPath = relPath ? `${relPath}` : "";
    const isFrench = cleanPath === "fr" || cleanPath.startsWith("fr/");
    const enSubPath = isFrench ? cleanPath.replace(/^fr\/?/, "") : cleanPath;

    const canonicalUrl = cleanPath ? `${siteUrl}${cleanPath}` : siteUrl;
    const enUrl = enSubPath ? `${siteUrl}${enSubPath}` : siteUrl;
    const frUrl = enSubPath ? `${siteUrl}fr/${enSubPath}` : `${siteUrl}fr/`;

    const pageTitle = pageData.title
      ? `${pageData.title} | EPURE`
      : "EPURE — Specification-Driven GitHub Engineering";
    const pageDescription =
      pageData.description ||
      (isFrench
        ? "Élaboration de Plans, Usinage, Revue et Exécution — Ingénierie Logicielle Gouvernée sur GitHub"
        : "Engineered Planning, Unified Review & Execution — Specification-Driven GitHub Engineering");

    const dynamicHead: HeadConfig[] = [
      ["link", { rel: "canonical", href: canonicalUrl }],
      ["link", { rel: "alternate", hreflang: "en-US", href: enUrl }],
      ["link", { rel: "alternate", hreflang: "fr-FR", href: frUrl }],
      ["link", { rel: "alternate", hreflang: "x-default", href: enUrl }],
      ["meta", { property: "og:title", content: pageTitle }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { property: "og:locale", content: isFrench ? "fr_FR" : "en_US" }],
      [
        "meta",
        {
          property: "og:locale:alternate",
          content: isFrench ? "en_US" : "fr_FR"
        }
      ],
      ["meta", { name: "twitter:title", content: pageTitle }],
      ["meta", { name: "twitter:description", content: pageDescription }]
    ];

    return dynamicHead;
  },
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
