import type { TokenUsageLedger } from "../usage/token-usage.js";
import type { GitRefStateStore } from "./git-ref-state.js";

/**
 * Writes the ledger's pending usage with each update of the epic's state ref, so metering adds no
 * commit of its own; other refs pass through unchanged.
 */
export function meterTokenUsage(
  store: GitRefStateStore,
  ledger: TokenUsageLedger,
  epicRefName: string
): GitRefStateStore {
  return {
    readRef: async (refName) => {
      const snapshot = await store.readRef(refName);
      if (refName === epicRefName) {
        ledger.observe(snapshot.state?.token_usage);
      }
      return snapshot;
    },
    compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
      const count = ledger.pendingCount();
      if (refName !== epicRefName || count === 0) {
        return store.compareAndSwapRef(refName, expectedOldSha, nextState);
      }
      const metered = { ...nextState, token_usage: ledger.fold(nextState.token_usage, count) };
      let result: Awaited<ReturnType<GitRefStateStore["compareAndSwapRef"]>>;
      try {
        result = await store.compareAndSwapRef(refName, expectedOldSha, metered);
      } catch (err) {
        // The write may have landed before the connection failed: writing its usage again would count it twice.
        const landed = await store.readRef(refName).then(
          (snapshot) => JSON.stringify(snapshot.state) === JSON.stringify(metered),
          () => false
        );
        if (landed) {
          ledger.written(metered.token_usage, count);
        }
        throw err;
      }
      if (result.swapped) {
        ledger.written(metered.token_usage, count);
      }
      return result;
    },
    ...(store.listIssueStates ? { listIssueStates: () => store.listIssueStates!() } : {})
  };
}
