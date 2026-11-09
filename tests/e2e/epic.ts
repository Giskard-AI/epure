// The scripted epic: small enough for two tickets, precise enough that grilling ends in one or two rounds.
export const EPIC_TITLE = "Add median and mode to the stats library";

export const EPIC_BODY = [
  "`src/stats.js` only exports `mean`. Add two functions next to it:",
  "",
  "- `median(values)`: the middle value of a sorted copy of `values`; for an even count, the mean of the two middle values.",
  "- `mode(values)`: every most frequent value, sorted ascending, as an array (ties return all tied values).",
  "",
  "Both functions validate their input exactly like `mean`: they throw `TypeError` for a non-array, an empty array or a non-finite number. They never mutate their input.",
  "",
  "Each function has vitest tests in `test/stats.test.js`. No new dependency, no other file than `src/stats.js` and `test/stats.test.js`.",
  "",
  "Plan exactly two tickets: `median` first, then `mode`."
].join("\n");

// Posted in order while grilling asks questions; the last answer repeats once the list runs out.
export const GRILL_ANSWERS = [
  [
    "Answers to all open questions:",
    "",
    "- Scope: only `median` and `mode` in `src/stats.js`, with tests in `test/stats.test.js`. Nothing else changes.",
    "- Validation: reuse the exact checks of `mean` (non-array, empty array, non-finite number -> `TypeError`). No coercion of strings.",
    "- `mode` returns a new array sorted ascending, even when only one value is most frequent.",
    "- No glossary terms beyond median and mode; no ADR is needed.",
    "- Two tickets, `median` then `mode`, independent of each other.",
    "",
    "I accept your recommendations on every other point."
  ].join("\n"),
  "I accept all your remaining recommendations. Nothing else is open: please close the grilling."
];
