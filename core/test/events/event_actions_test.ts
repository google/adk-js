/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {
  createEventActions,
  EventActions,
  isDefaultEventActions,
  mergeEventActions,
} from '../../src/events/event_actions.js';
import {
  recordStateWrite,
  shouldApplyDeltaWrite,
} from '../../src/sessions/state_write_order.js';
import {ToolConfirmation} from '../../src/tools/tool_confirmation.js';

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

describe('isDefaultEventActions', () => {
  it('returns true for freshly created actions', () => {
    expect(isDefaultEventActions(createEventActions())).toBe(true);
  });

  const nonDefaults: Array<[string, Partial<EventActions>]> = [
    ['stateDelta has an entry', {stateDelta: {jobStarted: true}}],
    ['artifactDelta has an entry', {artifactDelta: {'report.pdf': 1}}],
    [
      'requestedAuthConfigs has an entry',
      {
        requestedAuthConfigs: {
          'call-1': {
            authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
            credentialKey: 'call-1-key',
          },
        },
      },
    ],
    [
      'requestedToolConfirmations has an entry',
      {
        requestedToolConfirmations: {
          'call-1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
        },
      },
    ],
    ['skipSummarization is true', {skipSummarization: true}],
    ['skipSummarization is explicitly false', {skipSummarization: false}],
    ['transferToAgent is set', {transferToAgent: 'other_agent'}],
    ['escalate is set', {escalate: true}],
    ['agentState has an entry', {agentState: {nodeA: {step: 1}}}],
    ['endOfAgent is true', {endOfAgent: true}],
    ['endOfAgent is explicitly false', {endOfAgent: false}],
  ];

  it.each(nonDefaults)('returns false when %s', (_label, overrides) => {
    expect(isDefaultEventActions(createEventActions(overrides))).toBe(false);
  });

  it('returns true when agentState is empty', () => {
    expect(isDefaultEventActions(createEventActions({agentState: {}}))).toBe(
      true,
    );
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

  it('recursively merges nested plain objects in stateDelta without mutating target or sources', () => {
    const targetNested = {a: 1, deep: {keep: true, replace: 'old'}};
    const source1Nested = {b: 2, deep: {replace: 'new'}};
    const source2Nested = {c: 3, deep: {added: 42}};
    const target = createEventActions({
      stateDelta: {nested: targetNested},
      artifactDelta: {'base.txt': 1},
    });
    const source1 = createEventActions({
      stateDelta: {nested: source1Nested},
      artifactDelta: {'extra.txt': 2},
    });
    const source2 = createEventActions({
      stateDelta: {nested: source2Nested},
    });

    const result = mergeEventActions([source1, source2], target);

    expect(result.stateDelta).toEqual({
      nested: {a: 1, b: 2, c: 3, deep: {keep: true, replace: 'new', added: 42}},
    });
    expect(result.artifactDelta).toEqual({'base.txt': 1, 'extra.txt': 2});
    expect(target.stateDelta).toEqual({
      nested: {a: 1, deep: {keep: true, replace: 'old'}},
    });
    expect(target.artifactDelta).toEqual({'base.txt': 1});
    expect(source1.stateDelta).toEqual({
      nested: {b: 2, deep: {replace: 'new'}},
    });
    expect(source2.stateDelta).toEqual({
      nested: {c: 3, deep: {added: 42}},
    });
  });

  it('preserves write-order stamps across merged stateDelta entries', () => {
    const sessionState: Record<string, unknown> = {};
    const targetDelta: Record<string, unknown> = {baseKey: 'base'};
    const delta1: Record<string, unknown> = {staleKey: 'old'};
    const delta2: Record<string, unknown> = {freshKey: 'fresh'};

    recordStateWrite(sessionState, targetDelta, 'baseKey');
    recordStateWrite(sessionState, delta1, 'staleKey');
    recordStateWrite(sessionState, delta2, 'freshKey');
    // Supersede staleKey directly in sessionState after delta1 was recorded.
    recordStateWrite(sessionState, undefined, 'staleKey');

    const result = mergeEventActions(
      [{stateDelta: delta1}, {stateDelta: delta2}],
      createEventActions({stateDelta: targetDelta}),
    );

    expect(
      shouldApplyDeltaWrite(sessionState, result.stateDelta, 'staleKey'),
    ).toBe(false);
    expect(
      shouldApplyDeltaWrite(sessionState, result.stateDelta, 'baseKey'),
    ).toBe(true);
    expect(
      shouldApplyDeltaWrite(sessionState, result.stateDelta, 'freshKey'),
    ).toBe(true);
  });

  it('keeps the highest write-order stamp when deep-merging nested plain objects', () => {
    const sessionState: Record<string, unknown> = {};
    const olderDelta: Record<string, unknown> = {profile: {role: 'admin'}};
    const newerDelta: Record<string, unknown> = {profile: {name: 'Ada'}};

    recordStateWrite(sessionState, olderDelta, 'profile');
    recordStateWrite(sessionState, newerDelta, 'profile');

    const result = mergeEventActions([
      {stateDelta: newerDelta},
      {stateDelta: olderDelta},
    ]);

    expect(result.stateDelta).toEqual({
      profile: {name: 'Ada', role: 'admin'},
    });
    expect(
      shouldApplyDeltaWrite(sessionState, result.stateDelta, 'profile'),
    ).toBe(true);
  });

  it('does not leak a stale stamp onto an unstamped override or merged delta', () => {
    const sessionState: Record<string, unknown> = {};
    const staleScalarDelta: Record<string, unknown> = {k: 'old'};
    const staleNestedDelta: Record<string, unknown> = {
      nested: {fromStamped: 1},
    };

    recordStateWrite(sessionState, staleScalarDelta, 'k');
    recordStateWrite(sessionState, staleNestedDelta, 'nested');
    recordStateWrite(sessionState, undefined, 'k');
    recordStateWrite(sessionState, undefined, 'nested');

    const result = mergeEventActions([
      {stateDelta: staleScalarDelta},
      {stateDelta: staleNestedDelta},
      {
        stateDelta: {
          k: 'override',
          nested: {fromUnstamped: 2},
        },
      },
    ]);

    expect(result.stateDelta).toEqual({
      k: 'override',
      nested: {fromStamped: 1, fromUnstamped: 2},
    });
    expect(shouldApplyDeltaWrite(sessionState, result.stateDelta, 'k')).toBe(
      true,
    );
    expect(
      shouldApplyDeltaWrite(sessionState, result.stateDelta, 'nested'),
    ).toBe(true);
  });

  it('replaces arrays and class instances instead of merging them recursively', () => {
    const firstConfirmation = new ToolConfirmation({
      hint: 'first',
      confirmed: false,
    });
    const secondConfirmation = new ToolConfirmation({
      hint: 'second',
      confirmed: true,
    });

    const result = mergeEventActions([
      createEventActions({
        stateDelta: {
          items: [1, 2],
          confirmation: firstConfirmation,
        },
      }),
      createEventActions({
        stateDelta: {
          items: [3],
          confirmation: secondConfirmation,
        },
      }),
    ]);

    expect(result.stateDelta).toEqual({
      items: [3],
      confirmation: secondConfirmation,
    });
    expect(result.stateDelta['confirmation']).toBe(secondConfirmation);
  });

  it('ignores unsafe prototype keys during recursive record merging', () => {
    const malicious = JSON.parse(
      '{"nested":{"__proto__":{"polluted":true},"safe":"ok"}}',
    ) as Record<string, unknown>;

    const result = mergeEventActions([
      createEventActions({stateDelta: {nested: {initial: true}}}),
      createEventActions({stateDelta: malicious}),
    ]);

    expect(result.stateDelta).toEqual({
      nested: {initial: true, safe: 'ok'},
    });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('deep-merges agentState and applies last-writer-wins to endOfAgent', () => {
    const result = mergeEventActions([
      createEventActions({
        agentState: {nodeA: {step: 1, meta: {ok: true}}},
        endOfAgent: true,
      }),
      createEventActions({
        agentState: {nodeA: {meta: {retries: 2}}, nodeB: {done: true}},
        endOfAgent: false,
      }),
    ]);

    expect(result.agentState).toEqual({
      nodeA: {step: 1, meta: {ok: true, retries: 2}},
      nodeB: {done: true},
    });
    expect(result.endOfAgent).toBe(false);
  });
});
