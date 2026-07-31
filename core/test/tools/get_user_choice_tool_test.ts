/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, createEventActions, getUserChoiceTool} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('getUserChoiceTool', () => {
  it('computes the correct declaration', () => {
    const declaration = getUserChoiceTool._getDeclaration();
    expect(declaration?.name).toEqual('get_user_choice');
    expect(declaration?.description).toContain('Presents a list of options');
  });

  it('sets skipSummarization flag on execution', async () => {
    const mockActions = createEventActions();
    const mockContext = {actions: mockActions} as unknown as Context;

    const result = await getUserChoiceTool.runAsync({
      args: {options: ['A', 'B']},
      toolContext: mockContext,
    });

    expect(result).toBeNull();
    expect(mockActions.skipSummarization).toBe(true);
  });
});
