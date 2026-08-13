/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  createEvent,
  isEvent,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../src/events/event.js';

describe('Phase 0 — workflow event-model extensions', () => {
  it('carries first-class workflow fields on Event', () => {
    const ev = createEvent({
      author: 'node_a',
      output: {value: 42},
      route: 'question',
      nodeInfo: {
        path: 'wf.node_a',
        outputFor: ['wf.node_a'],
        messageAsOutput: true,
      },
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
      nodeInfo: {
        path: 'wf.node_a',
        outputFor: ['wf.node_a'],
        messageAsOutput: true,
      },
      isolationScope: 'wf:evt_123',
      actions: {agentState: {status: 3}, endOfAgent: true},
    });

    const snake = transformToSnakeCaseEvent(ev);
    // Verify Python-compatible key names on the wire.
    expect(snake['node_info']).toBeDefined();
    expect(
      (snake['node_info'] as Record<string, unknown>)['output_for'],
    ).toEqual(['wf.node_a']);
    expect(
      (snake['node_info'] as Record<string, unknown>)['message_as_output'],
    ).toBe(true);
    expect(snake['isolation_scope']).toBe('wf:evt_123');
    const snakeActions = snake['actions'] as Record<string, unknown>;
    expect(snakeActions['agent_state']).toEqual({status: 3});
    expect(snakeActions['end_of_agent']).toBe(true);

    const back = transformToCamelCaseEvent(snake);
    expect(back.nodeInfo?.path).toBe('wf.node_a');
    expect(back.nodeInfo?.outputFor).toEqual(['wf.node_a']);
    expect(back.nodeInfo?.messageAsOutput).toBe(true);
    expect(back.isolationScope).toBe('wf:evt_123');
    expect(back.route).toBe('question');
    expect(back.actions.agentState).toEqual({status: 3});
    expect(back.actions.endOfAgent).toBe(true);
  });

  it('preserves user-defined keys in output/route/agentState across persistence', () => {
    // A persistent session (e.g. VertexAiSessionService) round-trips events
    // through snake_case. The workflow's arbitrary payloads — node output, the
    // node input stashed under actions.agentState for HITL resume, and the
    // emitted route — carry user-defined keys that must survive verbatim. Without
    // the preserve-key allowlists, `{userName: 'Ada'}` would come back as
    // `{user_name: 'Ada'}` and a resumed node would re-run with mangled keys.
    const ev = createEvent({
      author: 'node_a',
      output: {userName: 'Ada', nested: {maxRetries: 3}},
      route: 'needsReview',
      actions: {
        agentState: {input: {firstName: 'Ada', lastName: 'Lovelace'}},
      },
    });

    const back = transformToCamelCaseEvent(transformToSnakeCaseEvent(ev));

    expect(back.output).toEqual({userName: 'Ada', nested: {maxRetries: 3}});
    expect(back.route).toBe('needsReview');
    expect(back.actions.agentState).toEqual({
      input: {firstName: 'Ada', lastName: 'Lovelace'},
    });
  });
});

describe('isEvent — signature-symbol brand', () => {
  it('recognizes events built by createEvent', () => {
    expect(isEvent(createEvent({author: 'node_a'}))).toBe(true);
  });

  it('rejects non-objects and null', () => {
    expect(isEvent(null)).toBe(false);
    expect(isEvent(undefined)).toBe(false);
    expect(isEvent('event')).toBe(false);
    expect(isEvent(42)).toBe(false);
  });

  it('rejects event-shaped impostors that lack the brand', () => {
    // Structurally event-like, but not produced by createEvent: the old
    // duck-typing guard would accept this; the brand-based guard does not.
    const impostor = {invocationId: 'inv-1', actions: {}, output: {value: 1}};
    expect(isEvent(impostor)).toBe(false);
  });

  it('drops the (non-serializable) brand across a snake/camel round-trip', () => {
    // The brand is a runtime marker only; a rehydrated event is not branded.
    const branded = createEvent({author: 'node_a', output: {value: 42}});
    const rehydrated = transformToCamelCaseEvent(
      transformToSnakeCaseEvent(branded),
    );
    expect(isEvent(branded)).toBe(true);
    expect(isEvent(rehydrated)).toBe(false);
  });
});
