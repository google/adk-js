/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../src/workflow/utils/hitl_utils.js';
import {createIc, driveNode} from './test_helpers.js';

describe('FunctionNode result handling', () => {
  it('yields one event per item from a generator handler', async () => {
    const node = new FunctionNode('gen', function* () {
      yield 'a';
      yield 'b';
    });
    const {events, output} = await driveNode(node);
    expect(events.map((e) => e.output)).toEqual(['a', 'b']);
    expect(output).toBe('b');
  });

  it('emits a genai Content result as the event content', async () => {
    const node = new FunctionNode('c', () => ({
      role: 'model',
      parts: [{text: 'hi'}],
    }));
    const {events} = await driveNode(node);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe('hi');
  });

  it('skips a null result with no pending state', async () => {
    const node = new FunctionNode('n', () => null);
    const {events, output} = await driveNode(node);
    expect(events).toHaveLength(0);
    expect(output).toBeUndefined();
  });

  it('passes an explicitly returned Event through', async () => {
    const node = new FunctionNode('e', () => createEvent({output: 'x'}));
    const {output} = await driveNode(node);
    expect(output).toBe('x');
  });
});

describe('FunctionNode state delta attachment', () => {
  it('attaches each written key only once across a multi-event run', async () => {
    const node = new FunctionNode('w', function* (ctx) {
      ctx.state.set('k', 1);
      yield 'a';
      yield 'b';
    });
    const {events} = await driveNode(node);
    // First event carries the write; the second does not re-emit it.
    expect(events[0].actions.stateDelta).toEqual({k: 1});
    expect(events[1].actions.stateDelta).toEqual({});
  });

  it('lets a handler-set event delta win over the context delta', async () => {
    const node = new FunctionNode('w', function* (ctx) {
      ctx.state.set('k', 'ctx');
      yield createEvent({output: 'x', actions: {stateDelta: {k: 'handler'}}});
    });
    const {events} = await driveNode(node);
    expect(events.at(-1)?.actions.stateDelta.k).toBe('handler');
  });
});

describe('FunctionNode auth gate', () => {
  const apiKeyConfig = (): AuthConfig => ({
    credentialKey: 'k',
    authScheme: {type: 'apiKey', name: 'k', in: 'header'},
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
  });

  it('interrupts with a credential request when none is available', async () => {
    const node = new FunctionNode('needsAuth', () => 'ran', {
      authConfig: apiKeyConfig(),
    });
    const {events, output} = await driveNode(node, 'x');

    // The handler never ran; a credential-request interrupt was emitted instead.
    expect(output).toBeUndefined();
    const fc = events.at(-1)?.content?.parts?.[0]?.functionCall;
    expect(fc?.name).toBe(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
    expect(events.at(-1)?.longRunningToolIds).toContain('k');
  });

  it('proceeds when the credential is supplied via resumeInputs', async () => {
    const node = new FunctionNode('needsAuth', () => 'ran', {
      authConfig: apiKeyConfig(),
    });
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
      resumeInputs: {k: 'my-key'},
    });
    const child = await root.runNode(node, 'x', {useAsOutput: true});
    expect(child.output).toBe('ran');
  });
});
