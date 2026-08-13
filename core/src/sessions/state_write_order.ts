/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Write ordering for session state, so that a state delta committed late cannot
 * roll a key back to an older value.
 *
 * `session.state` is written from two directions during a run. A writer — a
 * workflow node's `ctx.state`, a tool, a callback — sets a key immediately, and
 * that same write is also recorded in an event's `actions.stateDelta`, which
 * the session service re-applies when it commits that event. Commits lag
 * execution, so re-applying an earlier writer's delta can overwrite a later
 * writer's value:
 *
 *   a: set('attempts', 0)
 *   b: get -> 0, set('attempts', 1)
 *   commit(a) re-applies attempts=0        <- rolls back b's write
 *   c: get -> 0                            <- wrong; b already set 1
 *   commit(b) re-applies attempts=1        <- rolls forward, too late
 *
 * Every write takes a tick off one monotonic clock. A key's stamp on a state
 * object is the newest write that reached it; a key's stamp on a delta is the
 * write that put it there. Applying a delta entry that is older than the key's
 * current stamp would move it backwards, so it is skipped — `commit(a)` above
 * becomes a no-op and `c` reads 1.
 *
 * Stamps live in WeakMaps keyed by object identity, so nothing is added to the
 * state or the delta themselves: they never serialize, never reach a session
 * backend, and cost nothing once the objects are collected. A delta entry with
 * no stamp — one built by hand, or read back from a persisted session — is
 * applied unconditionally, exactly as it was before.
 */

/** Monotonic write counter, shared by every state writer in the process. */
let writeClock = 0;

/** For each state object, the stamp of the newest write to each of its keys. */
const stateStamps = new WeakMap<object, Map<string, number>>();

/** For each delta object, the stamp of the write that produced each entry. */
const deltaStamps = new WeakMap<object, Map<string, number>>();

function stampsFor(
  registry: WeakMap<object, Map<string, number>>,
  target: object,
): Map<string, number> {
  let stamps = registry.get(target);
  if (!stamps) {
    stamps = new Map();
    registry.set(target, stamps);
  }
  return stamps;
}

/**
 * Records a direct write of `key` into `state`, and — when the same write is
 * being recorded in `delta` for later commit — stamps it there too, so the
 * commit can tell whether it has since been superseded.
 */
export function recordStateWrite(
  state: object,
  delta: object | undefined,
  key: string,
): void {
  const stamp = ++writeClock;
  stampsFor(stateStamps, state).set(key, stamp);
  if (delta && delta !== state) {
    stampsFor(deltaStamps, delta).set(key, stamp);
  }
}

/**
 * Copies the stamp `delta` holds for `key` onto `state`, for a writer that
 * mirrors one logical write into more than one state object (a workflow node
 * writes through to `session.state` as well as to its own view). Both objects
 * then carry the same stamp, so neither can roll the other back.
 */
export function adoptDeltaStamp(
  state: object,
  delta: object,
  key: string,
): void {
  const stamp = deltaStamps.get(delta)?.get(key);
  if (stamp !== undefined) {
    stampsFor(stateStamps, state).set(key, stamp);
  }
}

/**
 * Whether committing `key` from `delta` into `state` should go ahead, recording
 * the write when it should.
 *
 * Returns false only when the delta entry is stamped and a newer write to that
 * key has already landed — the rollback this module exists to prevent.
 */
export function shouldApplyDeltaWrite(
  state: object,
  delta: object,
  key: string,
): boolean {
  const written = deltaStamps.get(delta)?.get(key);
  const current = stateStamps.get(state)?.get(key);
  if (written !== undefined && current !== undefined && current > written) {
    return false;
  }
  stampsFor(stateStamps, state).set(key, written ?? ++writeClock);
  return true;
}

/**
 * Carries the stamp for one key from one delta object to another.
 *
 * A delta is copied several times between the write and the commit — a node
 * drains its pending entries into a fresh map, `createEventActions` copies that
 * into the event, `trimTempDeltaState` rebuilds it again — and each copy is a
 * new object, so the stamps have to be carried with it. An entry that arrives
 * at the commit unstamped is applied unconditionally, which is the old
 * behaviour, so a missed hop degrades rather than breaks.
 */
export function carryDeltaStamp(from: object, to: object, key: string): void {
  const stamp = deltaStamps.get(from)?.get(key);
  if (stamp !== undefined) {
    stampsFor(deltaStamps, to).set(key, stamp);
  }
}

/** {@link carryDeltaStamp} for every key `from` carries a stamp for. */
export function carryDeltaStamps(from: object, to: object): void {
  const stamps = deltaStamps.get(from);
  if (!stamps) {
    return;
  }
  const carried = stampsFor(deltaStamps, to);
  for (const [key, stamp] of stamps) {
    carried.set(key, stamp);
  }
}
