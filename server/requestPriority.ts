import { AsyncLocalStorage } from "node:async_hooks";

export type RequestPriority = "high" | "low";

type RequestPriorityContext = { priority: RequestPriority };

const requestPriorityStore = new AsyncLocalStorage<RequestPriorityContext>();

/**
 * Runs `fn` with an explicit request priority. GitHub requests made anywhere
 * inside the callback — including transitively, across awaits — are tagged for
 * budget-reserve gating. The default outside any scope is "high", so only the
 * routine background sweep needs to opt into "low".
 */
export function runWithRequestPriority<T>(priority: RequestPriority, fn: () => T): T {
  return requestPriorityStore.run({ priority }, fn);
}

export function getRequestPriority(): RequestPriority {
  return requestPriorityStore.getStore()?.priority ?? "high";
}
