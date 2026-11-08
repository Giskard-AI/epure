import { describe, expect, it } from "vitest";
import { mean } from "../src/stats.js";

describe("mean", () => {
  it.each([
    { id: "single-value", values: [4], expected: 4 },
    { id: "integers", values: [1, 2, 3, 4], expected: 2.5 },
    { id: "negative-and-decimal", values: [-1.5, 0.5, 4], expected: 1 }
  ])("$id", ({ values, expected }) => {
    expect(mean(values)).toBe(expected);
  });

  it.each([
    { id: "empty-array", values: [] },
    { id: "not-an-array", values: "1,2" },
    { id: "nan-value", values: [1, Number.NaN] },
    { id: "string-value", values: [1, "2"] }
  ])("throws TypeError on $id", ({ values }) => {
    expect(() => mean(values)).toThrow(TypeError);
  });
});
