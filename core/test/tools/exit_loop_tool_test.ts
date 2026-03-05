/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEventActions,
  EXIT_LOOP,
  ExitLoopTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ExitLoopTool', () => {
  it('computes the correct declaration', () => {
    const tool = new ExitLoopTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('exit_loop');
    expect(declaration?.description).toEqual(
      'Exits the loop.\n\nCall this function only when you are instructed to do so.',
    );
    expect(declaration?.parameters).toBeUndefined();
  });

  it('sets escalate and skipSummarization flags on runAsync', async () => {
    const tool = new ExitLoopTool();
    const mockActions = createEventActions();
    const mockContext = {actions: mockActions} as unknown as Context;

    const result = await tool.runAsync({
      args: {},
      toolContext: mockContext,
    });

    expect(result).toEqual('');
    expect(mockActions.escalate).toBe(true);
    expect(mockActions.skipSummarization).toBe(true);
  });

  it('has a global instance EXIT_LOOP', () => {
    expect(EXIT_LOOP).toBeInstanceOf(ExitLoopTool);
  });
});
