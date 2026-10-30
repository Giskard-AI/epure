---
name: kill-slop-caveman
description: Enforce zero-supply-chain anti-AI-slop code discipline (kill-slop), ASD-STE100 Controlled Technical Prompting, and token-efficient communication (caveman lite Zero-Filler + Auto-Clarity) without external CLI proxies or third-party packages.
---

# Kill-Slop, ASD-STE100 & Caveman (`lite` Zero-Filler + Auto-Clarity)

First-party vendored discipline for `EPURE` (`ADR-0030`, `ADR-0031`). Zero external dependencies (`@caveman-ai/cli` and unverified third-party agent packages are forbidden).

## 1. Anti-Slop Code Discipline (`kill-slop` & Ponytail 5)

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
6. **Ponytail 5 Reuse Hierarchy, Caller-Reach & Safety Floor**:
   - Reuse order: (1) existing repo code, (2) standard library / platform primitives, (3) installed project dependencies, (4) minimal first-party code.
   - Update 100% of callers, exports, and tests in the same diff when changing an interface (`Caller-Reach`), and never remove security or trust-boundary checks (`Safety Floor`).

## 2. ASD-STE100 Controlled Technical Prompting (`ADR-0031`)

1. **Bijective domain vocabulary (`1 concept = 1 term`)**:
   - Use exclusively the canonical term from `GLOSSARY.md`; never use synonyms listed under `_Avoid_`.
2. **Active voice with explicit actor (`Subject-Verb-Object`)**:
   - Always name the module, function, or actor executing the action; ban agentless passive voice (`"must be validated"` -> `"syncBranchWithBase validates"`).
3. **Procedural atomicity (`1 sentence = 1 action`)**:
   - Express one verifiable action or condition per sentence (≤ 20 words for procedural steps, ≤ 25 words for descriptive statements).
4. **Deterministic conditionals (`WHEN/IF <condition>, THEN <actor> <action>`)**:
   - Ban vague modals (`should`, `might`, `could`, `if needed`, `if appropriate`, `as necessary`).

## 3. Token-Efficient Reasoning (`caveman` `lite` Zero-Filler + Auto-Clarity)

1. **Default `lite` (`Zero-Filler`) intensity**:
   - Drop pleasantries, filler, hedging, and restating the prompt while preserving full ASD-STE100 grammatical structure (`Subject-Verb-Object`).
   - Keep status updates and explanations concise: 1-4 short bullets or 1-2 short paragraphs.
2. **Auto-Clarity boundaries (never compress or abbreviate)**:
   - Code blocks, file paths, symbol names, CLI commands, and configuration keys.
   - Structured JSON schemas, Conventional Commit titles, PR bodies, and ADR/GLOSSARY entries.
   - Security warnings, multi-step order-of-operations, and root-cause diagnoses.
