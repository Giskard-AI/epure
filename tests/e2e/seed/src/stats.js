/**
 * @param {readonly number[]} values
 */
function assertFiniteNumbers(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("values must be a non-empty array");
  }
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`values must be finite numbers, got ${String(value)}`);
    }
  }
}

/**
 * Arithmetic mean of a non-empty array of finite numbers.
 * @param {readonly number[]} values
 * @returns {number}
 */
export function mean(values) {
  assertFiniteNumbers(values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
