/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemorySessionService,
  State,
  createEvent,
  createEventActions,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  recordStateWrite,
  shouldApplyDeltaWrite,
} from '../../src/sessions/state_write_order.js';

describe('shouldApplyDeltaWrite', () => {
  it('applies an unstamped delta entry unconditionally', () => {
    const state: Record<string, unknown> = {};
    const delta: Record<string, unknown> = {key: 'value'};
    expect(shouldApplyDeltaWrite(state, delta, 'key')).toBe(true);
  });

  it('rejects a stale delta entry once a newer write has landed', () => {
    // The rollback this module exists to prevent: writer A stamps its delta,
    // writer B then supersedes the key on the state object, and A's delta
    // arrives at commit late. It must be skipped, not re-applied.
    const state: Record<string, unknown> = {};
    const deltaA: Record<string, unknown> = {key: 'old'};
    const deltaB: Record<string, unknown> = {key: 'new'};
    recordStateWrite(state, deltaA, 'key');
    recordStateWrite(state, deltaB, 'key');

    expect(shouldApplyDeltaWrite(state, deltaA, 'key')).toBe(false);
    expect(shouldApplyDeltaWrite(state, deltaB, 'key')).toBe(true);
  });

  it('skips a stale sibling delta at session commit', async () => {
    // End-to-end through the real commit path: two writers hit the same
    // session.state key, then the OLDER writer's event commits last. The
    // commit must not roll the key back to the older value.
    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: 'app',
      userId: 'user',
    });

    // Write through State exactly as a tool's Context does: the delta object
    // handed to the event is the one the State stamped.
    const earlyDelta: Record<string, unknown> = {};
    const earlyState = new State(session.state, earlyDelta);
    earlyState.set('key', 'early');

    const lateDelta: Record<string, unknown> = {};
    const lateState = new State(session.state, lateDelta);
    lateState.set('key', 'late');

    // The older event commits AFTER the newer write already landed.
    await service.appendEvent({
      session,
      event: createEvent({
        actions: createEventActions({stateDelta: earlyDelta}),
      }),
    });

    expect(session.state.key).toBe('late');

    await service.appendEvent({
      session,
      event: createEvent({
        actions: createEventActions({stateDelta: lateDelta}),
      }),
    });
    expect(session.state.key).toBe('late');
  });
});
