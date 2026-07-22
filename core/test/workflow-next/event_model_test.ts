/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  createEvent,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../src/events/event.js';

describe('Phase 0 — workflow event-model extensions', () => {
  it('carries first-class workflow fields on Event', () => {
    const ev = createEvent({
      author: 'node_a',
      output: {value: 42},
      route: 'question',
      nodeInfo: {path: 'wf.node_a', outputFor: 'run_1', messageAsOutput: true},
      isolationScope: 'wf:evt_123',
      actions: {agentState: {status: 3}, endOfAgent: true},
    });
    expect(ev.output).toEqual({value: 42});
    expect(ev.route).toBe('question');
    expect(ev.nodeInfo?.path).toBe('wf.node_a');
    expect(ev.nodeInfo?.messageAsOutput).toBe(true);
    expect(ev.isolationScope).toBe('wf:evt_123');
    expect(ev.actions.agentState).toEqual({status: 3});
    expect(ev.actions.endOfAgent).toBe(true);
  });

  it('round-trips new fields through snake_case <-> camelCase', () => {
    const ev = createEvent({
      author: 'node_a',
      output: {value: 42},
      route: 'question',
      nodeInfo: {path: 'wf.node_a', outputFor: 'run_1', messageAsOutput: true},
      isolationScope: 'wf:evt_123',
      actions: {agentState: {status: 3}, endOfAgent: true},
    });

    const snake = transformToSnakeCaseEvent(ev);
    // Verify Python-compatible key names on the wire.
    expect(snake['node_info']).toBeDefined();
    expect((snake['node_info'] as Record<string, unknown>)['output_for']).toBe(
      'run_1',
    );
    expect(
      (snake['node_info'] as Record<string, unknown>)['message_as_output'],
    ).toBe(true);
    expect(snake['isolation_scope']).toBe('wf:evt_123');
    const snakeActions = snake['actions'] as Record<string, unknown>;
    expect(snakeActions['agent_state']).toEqual({status: 3});
    expect(snakeActions['end_of_agent']).toBe(true);

    const back = transformToCamelCaseEvent(snake);
    expect(back.nodeInfo?.path).toBe('wf.node_a');
    expect(back.nodeInfo?.outputFor).toBe('run_1');
    expect(back.nodeInfo?.messageAsOutput).toBe(true);
    expect(back.isolationScope).toBe('wf:evt_123');
    expect(back.route).toBe('question');
    expect(back.actions.agentState).toEqual({status: 3});
    expect(back.actions.endOfAgent).toBe(true);
  });
});
