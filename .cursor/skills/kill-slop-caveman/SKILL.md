---
name: kill-slop-caveman
description: Enforce zero-supply-chain anti-AI-slop code discipline (kill-slop) and token-efficient communication (caveman lite + Auto-Clarity) without external CLI proxies or third-party packages.
---

# Kill-Slop & Caveman (`lite` + Auto-Clarity)

First-party vendored discipline for `EPURE` (`ADR-0030`). Zero external dependencies (`@caveman-ai/cli` and unverified third-party agent packages are forbidden).

## 1. Anti-Slop Code Discipline (`kill-slop`)

1. **Minimal surgical diffs**:
   - Touch only the lines directly required by the user request, ticket specification, or review finding.
   - Never perform drive-by refactors, formatting sweeps, or renames on unrelated code.
2. **No single-use abstractions or file sprawl**:
   - Do not create `utils/`, `helpers/`, or wrapper classes for logic used in a single call site.
   - Prefer inline, direct, readable logic inside existing modules.
3. **No unrequested dependencies or speculative config**:
   - Do not add packages, feature flags, or fallback branches that were not requested.
4. **No restating comments**:
   - Do not write comments that narrate what the next line of code does. Document only non-obvious invariants or security boundaries.
5. **Clean up your own orphans**:
   - Immediately remove any unused imports, variables, or helpers created by your edits.

## 2. Token-Efficient Reasoning (`caveman` `lite` + Auto-Clarity)

1. **Default `lite` intensity**:
   - Drop pleasantries, filler, hedging, and restating the prompt.
   - Keep status updates and explanations concise: 1-4 short bullets or 1-2 short paragraphs.
2. **Auto-Clarity boundaries (never compress or abbreviate)**:
   - Code blocks, file paths, symbol names, CLI commands, and configuration keys.
   - Structured JSON schemas, Conventional Commit titles, PR bodies, and ADR/GLOSSARY entries.
   - Security warnings, multi-step order-of-operations, and root-cause diagnoses.
