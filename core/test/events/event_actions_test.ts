/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {
  createEventActions,
  mergeEventActions,
} from '../../src/events/event_actions.js';

function createTestAuthConfig(credentialKey: string): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
    credentialKey,
  };
}

describe('createEventActions', () => {
  it('creates an EventActions with empty dicts and no scalar fields', () => {
    const actions = createEventActions();
    expect(actions.stateDelta).toEqual({});
    expect(actions.artifactDelta).toEqual({});
    expect(actions.requestedAuthConfigs).toEqual({});
    expect(actions.requestedToolConfirmations).toEqual({});
    expect(actions.skipSummarization).toBeUndefined();
    expect(actions.transferToAgent).toBeUndefined();
    expect(actions.escalate).toBeUndefined();
  });

  it('applies a partial stateDelta override', () => {
    const actions = createEventActions({stateDelta: {key: 'value'}});
    expect(actions.stateDelta).toEqual({key: 'value'});
    expect(actions.artifactDelta).toEqual({});
  });

  it('applies scalar field overrides', () => {
    const actions = createEventActions({
      skipSummarization: true,
      transferToAgent: 'agent-b',
      escalate: true,
    });
    expect(actions.skipSummarization).toBe(true);
    expect(actions.transferToAgent).toBe('agent-b');
    expect(actions.escalate).toBe(true);
  });

  it('applies requestedAuthConfigs override', () => {
    const authConfig = createTestAuthConfig('key-1');
    const actions = createEventActions({
      requestedAuthConfigs: {'call-1': authConfig},
    });
    expect(actions.requestedAuthConfigs).toEqual({'call-1': authConfig});
  });

  it('applies requestedToolConfirmations override', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const confirmation = {toolName: 'my_tool'} as any;
    const actions = createEventActions({
      requestedToolConfirmations: {'call-1': confirmation},
    });
    expect(actions.requestedToolConfirmations).toEqual({
      'call-1': confirmation,
    });
  });
});

describe('mergeEventActions', () => {
  it('returns empty EventActions when sources array is empty', () => {
    const result = mergeEventActions([]);
    expect(result.stateDelta).toEqual({});
    expect(result.artifactDelta).toEqual({});
    expect(result.requestedAuthConfigs).toEqual({});
    expect(result.requestedToolConfirmations).toEqual({});
    expect(result.skipSummarization).toBeUndefined();
    expect(result.transferToAgent).toBeUndefined();
    expect(result.escalate).toBeUndefined();
  });

  it('merges stateDelta from multiple sources', () => {
    const result = mergeEventActions([
      {
        stateDelta: {a: 1},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      {
        stateDelta: {b: 2},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    ]);
    expect(result.stateDelta).toEqual({a: 1, b: 2});
  });

  it('deep-merges plain objects under the same stateDelta key', () => {
    // Mirrors Python ADK's deep_merge_dicts (functions.py) used by
    // merge_parallel_function_response_events.
    const result = mergeEventActions([
      createEventActions({stateDelta: {user: {profile: {name: 'a'}, x: 1}}}),
      createEventActions({stateDelta: {user: {profile: {age: 2}, y: 3}}}),
    ]);
    expect(result.stateDelta).toEqual({
      user: {profile: {name: 'a', age: 2}, x: 1, y: 3},
    });
  });

  it('does not mutate source stateDelta objects when deep-merging', () => {
    const first = createEventActions({stateDelta: {user: {a: 1}}});
    const second = createEventActions({stateDelta: {user: {b: 2}}});
    mergeEventActions([first, second]);
    expect(first.stateDelta).toEqual({user: {a: 1}});
    expect(second.stateDelta).toEqual({user: {b: 2}});
  });

  it('keeps a nested __proto__ own key and does not re-parent the merge', () => {
    // A tool can legitimately write attacker-shaped JSON into state
    // (`state.set('user', await res.json())`). The nested merge must store
    // `__proto__` as an own data property — assigning it through a plain
    // object would instead invoke the inherited setter, silently dropping
    // the entry and swapping the merged object's prototype.
    const poisoned = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "ok": 1}',
    ) as Record<string, unknown>;
    const result = mergeEventActions([
      createEventActions({stateDelta: {user: {name: 'alice'}}}),
      createEventActions({stateDelta: {user: poisoned}}),
    ]);
    const user = result.stateDelta.user as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(['__proto__', 'name', 'ok']);
    expect(Object.getOwnPropertyDescriptor(user, '__proto__')?.value).toEqual({
      polluted: 'yes',
    });
    expect('polluted' in user).toBe(false);
  });

  it('keeps a base-side __proto__ own key across the nested merge', () => {
    const poisoned = JSON.parse('{"__proto__": {"polluted": "yes"}}') as Record<
      string,
      unknown
    >;
    const result = mergeEventActions([
      createEventActions({stateDelta: {user: poisoned}}),
      createEventActions({stateDelta: {user: {name: 'alice'}}}),
    ]);
    const user = result.stateDelta.user as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(['__proto__', 'name']);
    expect('polluted' in user).toBe(false);
  });

  it('merges self-referencing values without exhausting the call stack', () => {
    // State is expected to be JSON-serializable, but a cycle must degrade to
    // last-writer-wins instead of a RangeError deep inside event merging.
    const first: Record<string, unknown> = {tag: 'first'};
    first.self = first;
    const second: Record<string, unknown> = {tag: 'second'};
    second.self = second;
    const result = mergeEventActions([
      createEventActions({stateDelta: {key: first}}),
      createEventActions({stateDelta: {key: second}}),
    ]);
    const merged = result.stateDelta.key as Record<string, unknown>;
    expect(merged.tag).toBe('second');
    // The cycle falls back to last-writer-wins for the self-referencing entry.
    expect(merged.self).toBe(second);
  });

  it('overwrites arrays under the same stateDelta key (last write wins)', () => {
    // Python parity: deep_merge_dicts does NOT concatenate lists — upstream
    // added concatenation in adk-python PR #5191 and reverted it the same day.
    const result = mergeEventActions([
      createEventActions({stateDelta: {items: [1, 2]}}),
      createEventActions({stateDelta: {items: [3]}}),
    ]);
    expect(result.stateDelta.items).toEqual([3]);
  });

  it('overwrites when types differ under the same stateDelta key', () => {
    const result = mergeEventActions([
      createEventActions({stateDelta: {k: {nested: true}, j: 'scalar'}}),
      createEventActions({stateDelta: {k: 'scalar', j: {nested: true}}}),
    ]);
    expect(result.stateDelta.k).toBe('scalar');
    expect(result.stateDelta.j).toEqual({nested: true});
  });

  it('preserves an explicit null/undefined stateDelta entry as a clear', () => {
    // Python parity: exclude_none drops unset model FIELDS, but None values
    // inside state_delta survive the merge as explicit clears.
    const result = mergeEventActions([
      createEventActions({stateDelta: {a: {keep: 1}}}),
      createEventActions({stateDelta: {a: null, b: undefined}}),
    ]);
    expect(result.stateDelta.a).toBeNull();
    expect('b' in result.stateDelta).toBe(true);
    expect(result.stateDelta.b).toBeUndefined();
  });

  it('merges artifactDelta from multiple sources', () => {
    const result = mergeEventActions([
      {
        stateDelta: {},
        artifactDelta: {'file.txt': 1},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      {
        stateDelta: {},
        artifactDelta: {'other.txt': 2},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    ]);
    expect(result.artifactDelta).toEqual({'file.txt': 1, 'other.txt': 2});
  });

  it('merges requestedAuthConfigs from multiple sources', () => {
    const authConfig1 = createTestAuthConfig('key-1');
    const authConfig2 = createTestAuthConfig('key-2');
    const result = mergeEventActions([
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {'call-1': authConfig1},
        requestedToolConfirmations: {},
      },
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {'call-2': authConfig2},
        requestedToolConfirmations: {},
      },
    ]);
    expect(result.requestedAuthConfigs).toEqual({
      'call-1': authConfig1,
      'call-2': authConfig2,
    });
  });

  it('merges requestedToolConfirmations from multiple sources', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf1 = {toolName: 'tool-a'} as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf2 = {toolName: 'tool-b'} as any;
    const result = mergeEventActions([
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {'call-1': conf1},
      },
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {'call-2': conf2},
      },
    ]);
    expect(result.requestedToolConfirmations).toEqual({
      'call-1': conf1,
      'call-2': conf2,
    });
  });

  it('uses last-writer-wins for skipSummarization', () => {
    const result = mergeEventActions([
      createEventActions({skipSummarization: false}),
      createEventActions({skipSummarization: true}),
    ]);
    expect(result.skipSummarization).toBe(true);
  });

  it('uses last-writer-wins for transferToAgent', () => {
    const result = mergeEventActions([
      createEventActions({transferToAgent: 'agent-a'}),
      createEventActions({transferToAgent: 'agent-b'}),
    ]);
    expect(result.transferToAgent).toBe('agent-b');
  });

  it('uses last-writer-wins for escalate', () => {
    const result = mergeEventActions([
      createEventActions({escalate: false}),
      createEventActions({escalate: true}),
    ]);
    expect(result.escalate).toBe(true);
  });

  it('applies target as the base before merging sources', () => {
    const target = createEventActions({stateDelta: {base: 'val'}});
    const result = mergeEventActions(
      [
        {
          stateDelta: {extra: 'new'},
          artifactDelta: {},
          requestedAuthConfigs: {},
          requestedToolConfirmations: {},
        },
      ],
      target,
    );
    expect(result.stateDelta).toEqual({base: 'val', extra: 'new'});
  });

  it('ignores falsy sources', () => {
    const result = mergeEventActions([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
      createEventActions({stateDelta: {x: 1}}),
    ]);
    expect(result.stateDelta).toEqual({x: 1});
  });
});
