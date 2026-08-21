/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {reservedFunctionCallName} from '../../src/agents/framework_function_calls.js';

describe('reservedFunctionCallName', () => {
  it.each([
    'adk_request_confirmation',
    'adk_request_credential',
    'adk_request_input',
  ])('finds a %s call', (name) => {
    expect(
      reservedFunctionCallName({
        role: 'user',
        parts: [{text: 'hi'}, {functionCall: {id: 'x', name, args: {}}}],
      }),
    ).toBe(name);
  });

  it('ignores an ordinary tool call', () => {
    expect(
      reservedFunctionCallName({
        role: 'user',
        parts: [{functionCall: {id: 'x', name: 'wire_transfer', args: {}}}],
      }),
    ).toBeUndefined();
  });

  it('ignores a function response that answers a reserved call', () => {
    expect(
      reservedFunctionCallName({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'x',
              name: 'adk_request_confirmation',
              response: {confirmed: true},
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('ignores a call with no name', () => {
    expect(
      reservedFunctionCallName({role: 'user', parts: [{functionCall: {}}]}),
    ).toBeUndefined();
  });

  it('handles content with no parts, and no content at all', () => {
    expect(reservedFunctionCallName({role: 'user'})).toBeUndefined();
    expect(reservedFunctionCallName(undefined)).toBeUndefined();
  });
});
