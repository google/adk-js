/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import type {Event} from '../../src/events/event.js';
import {State} from '../../src/sessions/state.js';
import {toJsonSchema} from '../../src/utils/schema.js';
import {
  isRequestInput,
  RequestInput,
} from '../../src/workflow/request_input.js';
import {
  createRequestInputEvent,
  createRequestInputResponse,
  getRequestInputInterruptIds,
  hasAuthCredential,
  hasRequestInputFunctionCall,
  processAuthResume,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  responseSchemasByInterruptId,
  validateInterruptResponse,
} from '../../src/workflow/utils/hitl_utils.js';
import {unwrapResponse} from '../../src/workflow/utils/rehydration_utils.js';

/** Extracts the first function-call args from an event. */
function firstFunctionCall(event: Event) {
  return event.content?.parts?.[0]?.functionCall;
}

describe('RequestInput', () => {
  it('auto-generates an interrupt id when omitted', () => {
    const ri = new RequestInput();
    expect(typeof ri.interruptId).toBe('string');
    expect(ri.interruptId.length).toBeGreaterThan(0);
    expect(ri.payload).toBeUndefined();
    expect(ri.message).toBeUndefined();
    expect(ri.responseSchema).toBeUndefined();
  });

  it('keeps the provided fields', () => {
    const ri = new RequestInput({
      interruptId: 'i1',
      payload: {a: 1},
      message: 'm',
    });
    expect(ri.interruptId).toBe('i1');
    expect(ri.payload).toEqual({a: 1});
    expect(ri.message).toBe('m');
  });
});

describe('isRequestInput', () => {
  it('recognizes a RequestInput instance', () => {
    expect(isRequestInput(new RequestInput())).toBe(true);
  });

  it('rejects look-alikes and non-objects', () => {
    expect(isRequestInput({interruptId: 'x'})).toBe(false);
    expect(isRequestInput(null)).toBe(false);
    expect(isRequestInput('i1')).toBe(false);
  });
});

describe('createRequestInputEvent', () => {
  it('builds an interrupt event with a request_input function call', () => {
    const ri = new RequestInput({
      interruptId: 'i1',
      message: 'pick',
      payload: {x: 1},
    });
    const event = createRequestInputEvent(ri);
    const fc = firstFunctionCall(event);

    expect(fc?.name).toBe(REQUEST_INPUT_FUNCTION_CALL_NAME);
    expect(fc?.id).toBe('i1');
    expect(fc?.args).toMatchObject({
      interruptId: 'i1',
      message: 'pick',
      payload: {x: 1},
      responseSchema: null,
    });
    expect(event.longRunningToolIds).toEqual(['i1']);
    expect(hasRequestInputFunctionCall(event)).toBe(true);
    expect(getRequestInputInterruptIds(event)).toEqual(['i1']);
  });

  it('converts a Zod v4 responseSchema to a JSON schema', () => {
    const ri = new RequestInput({
      responseSchema: z4.object({answer: z4.string()}),
    });
    const args = firstFunctionCall(createRequestInputEvent(ri))?.args as Record<
      string,
      unknown
    >;
    expect(args.responseSchema).toMatchObject({type: 'object'});
  });

  it('converts a Zod v3 responseSchema to a JSON schema', () => {
    const ri = new RequestInput({
      responseSchema: z3.object({answer: z3.string()}),
    });
    const args = firstFunctionCall(createRequestInputEvent(ri))?.args as Record<
      string,
      unknown
    >;
    expect(args.responseSchema).toMatchObject({type: 'object'});
  });

  it('converts a genai Schema responseSchema to a JSON schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };
    const ri = new RequestInput({responseSchema: schema});
    const args = firstFunctionCall(createRequestInputEvent(ri))?.args as Record<
      string,
      unknown
    >;
    // Emitted in the same JSON Schema dialect as a Zod responseSchema, so a
    // client reading this field does not have to handle two type spellings.
    expect(args.responseSchema).toEqual({
      type: 'object',
      properties: {answer: {type: 'string'}},
    });
  });
});

describe('createRequestInputResponse', () => {
  it('builds a function-response part for the interrupt', () => {
    const part = createRequestInputResponse('i1', {value: 5});
    expect(part.functionResponse).toEqual({
      id: 'i1',
      name: REQUEST_INPUT_FUNCTION_CALL_NAME,
      response: {value: 5},
    });
  });
});

describe('auth gate', () => {
  const apiKeyConfig = (): AuthConfig => ({
    credentialKey: 'testKey',
    authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
  });

  it('reports no credential for an empty state', () => {
    expect(hasAuthCredential(apiKeyConfig(), new State())).toBe(false);
  });

  it('stores an API-key credential from a plain resume value', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({responseData: 'my-key', authConfig, state});

    expect(hasAuthCredential(authConfig, state)).toBe(true);
    expect(state.get('temp:testKey')).toEqual({
      authType: 'apiKey',
      apiKey: 'my-key',
    });
  });
});

describe('responseSchemasByInterruptId', () => {
  it('recovers the schema an interrupt declared, keyed by id', () => {
    const event = createRequestInputEvent(
      new RequestInput({
        interruptId: 'i1',
        responseSchema: z4.object({userResponse: z4.string()}),
      }),
    );

    const schemas = responseSchemasByInterruptId([event]);

    expect(schemas.get('i1')).toMatchObject({type: 'object'});
  });

  it('omits interrupts that declared no schema', () => {
    const event = createRequestInputEvent(
      new RequestInput({interruptId: 'i1'}),
    );

    expect(responseSchemasByInterruptId([event]).has('i1')).toBe(false);
  });
});

describe('validateInterruptResponse', () => {
  const objectSchema = toJsonSchema(z4.object({userResponse: z4.string()}));

  it('accepts a reply matching the declared schema', () => {
    expect(() =>
      validateInterruptResponse('i1', {userResponse: 'yes'}, objectSchema),
    ).not.toThrow();
  });

  it('rejects a reply in the wrong shape, naming the interrupt', () => {
    // The `{response: x}` envelope a client reaches for instead of `{result: x}`:
    // it is not unwrapped, so the whole object arrives as the node's input.
    expect(() =>
      validateInterruptResponse('i1', {response: '21'}, objectSchema),
    ).toThrow(/reply to interrupt 'i1' does not match/i);
  });

  it('explains how a structured reply is expected to look', () => {
    expect(() =>
      validateInterruptResponse('i1', {response: '21'}, objectSchema),
    ).toThrow(/\{result: <value>\}/);
  });

  it('passes through when the interrupt declared no schema', () => {
    expect(() =>
      validateInterruptResponse('i1', {anything: true}, undefined),
    ).not.toThrow();
  });

  it('passes through when the schema cannot be compiled', () => {
    expect(() =>
      validateInterruptResponse('i1', 'anything', {
        $ref: 'https://example.com/unresolvable.json',
      }),
    ).not.toThrow();
  });

  it('checks the unwrapped value, so {result: x} satisfies a bare schema', () => {
    const stringSchema = toJsonSchema(z4.string());
    expect(() =>
      validateInterruptResponse(
        'i1',
        unwrapResponse({result: '21'}),
        stringSchema,
      ),
    ).not.toThrow();
  });
});
