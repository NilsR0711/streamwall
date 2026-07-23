import type { EventEmitter } from 'node:events'

// Async generator resumption (and therefore listener registration inside
// the generator body) is not synchronous with the .next() call that
// triggers it, so tests poll for the listener rather than emitting
// immediately after calling next().
export async function waitForListener(
  emitter: EventEmitter,
  event: string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (emitter.listenerCount(event) > 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`listener for "${event}" was not registered in time`)
}
