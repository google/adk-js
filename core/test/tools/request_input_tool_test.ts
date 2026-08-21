/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, createEventActions, requestInputTool} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('requestInputTool', () => {
  it('computes the correct declaration', () => {
    const declaration = requestInputTool._getDeclaration();
    expect(declaration?.name).toEqual('adk_request_input');
    expect(declaration?.description).toContain('Presents a custom message');
  });

  it('asks the model for the schema under the key clients read', () => {
    // Same spelling a workflow `RequestInput` uses on the wire, so a client
    // renders a reply form for either kind of pause.
    const declaration = requestInputTool._getDeclaration();

    expect(Object.keys(declaration?.parameters?.properties ?? {})).toEqual([
      'message',
      'response_schema',
    ]);
  });

  it('sets skipSummarization flag on execution', async () => {
    const mockActions = createEventActions();
    const mockContext = {actions: mockActions} as unknown as Context;

    const result = await requestInputTool.runAsync({
      args: {message: 'Please provide user input'},
      toolContext: mockContext,
    });

    expect(result).toBeNull();
    expect(mockActions.skipSummarization).toBe(true);
  });
});
