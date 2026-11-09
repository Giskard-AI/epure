import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The seed is the sandbox's own project: its CI runs its tests.
    exclude: [...configDefaults.exclude, "tests/e2e/seed/**"]
  }
});
