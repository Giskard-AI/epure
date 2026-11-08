import type { TokenUsageLedger } from "../usage/token-usage.js";
import type { GitRefStateStore } from "./git-ref-state.js";

/** Writes the ledger's pending usage with each state update, so metering adds no commit of its own. */
export function meterTokenUsage(store: GitRefStateStore, ledger: TokenUsageLedger): GitRefStateStore {
  return {
    readRef: async (refName) => {
      const snapshot = await store.readRef(refName);
      ledger.observe(snapshot.state?.token_usage);
      return snapshot;
    },
    compareAndSwapRef: async (refName, expectedOldSha, nextState) => {
      const count = ledger.pendingCount();
      if (count === 0) {
        return store.compareAndSwapRef(refName, expectedOldSha, nextState);
      }
      const token_usage = ledger.fold(nextState.token_usage, count);
      const result = await store.compareAndSwapRef(refName, expectedOldSha, { ...nextState, token_usage });
      if (result.swapped) {
        ledger.written(token_usage, count);
      }
      return result;
    },
    ...(store.listIssueStates ? { listIssueStates: () => store.listIssueStates!() } : {})
  };
}
