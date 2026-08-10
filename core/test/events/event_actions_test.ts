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
