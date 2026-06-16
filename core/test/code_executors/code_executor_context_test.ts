/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {CodeExecutorContext} from '../../src/code_executors/code_executor_context.js';
import {State} from '../../src/sessions/state.js';

function makeContext(initial: Record<string, unknown> = {}): {
  state: State;
  ctx: CodeExecutorContext;
} {
  const state = new State(initial);
  return {state, ctx: new CodeExecutorContext(state)};
}

describe('CodeExecutorContext', () => {
  describe('getStateDelta', () => {
    it('returns an empty context delta when state has no context key', () => {
      const {ctx} = makeContext();
      const delta = ctx.getStateDelta();
      expect(delta).toEqual({_code_execution_context: {}});
    });

    it('returns a deep clone so mutations do not affect the stored context', () => {
      const {ctx} = makeContext();
      ctx.setExecutionId('abc');
      const delta = ctx.getStateDelta() as Record<
        string,
        Record<string, unknown>
      >;
      delta['_code_execution_context']['execution_session_id'] = 'mutated';
      expect(ctx.getExecutionId()).toBe('abc');
    });
  });

  describe('getExecutionId / setExecutionId', () => {
    it('returns undefined when execution ID has not been set', () => {
      const {ctx} = makeContext();
      expect(ctx.getExecutionId()).toBeUndefined();
    });

    it('returns the execution ID after setting it', () => {
      const {ctx} = makeContext();
      ctx.setExecutionId('session-123');
      expect(ctx.getExecutionId()).toBe('session-123');
    });

    it('overwrites an existing execution ID', () => {
      const {ctx} = makeContext();
      ctx.setExecutionId('first');
      ctx.setExecutionId('second');
      expect(ctx.getExecutionId()).toBe('second');
    });
  });

  describe('getProcessedFileNames / addProcessedFileNames', () => {
    it('returns an empty array when no file names have been added', () => {
      const {ctx} = makeContext();
      expect(ctx.getProcessedFileNames()).toEqual([]);
    });

    it('returns added file names', () => {
      const {ctx} = makeContext();
      ctx.addProcessedFileNames(['a.csv', 'b.csv']);
      expect(ctx.getProcessedFileNames()).toEqual(['a.csv', 'b.csv']);
    });

    it('appends on a second call', () => {
      const {ctx} = makeContext();
      ctx.addProcessedFileNames(['a.csv']);
      ctx.addProcessedFileNames(['b.csv']);
      expect(ctx.getProcessedFileNames()).toEqual(['a.csv', 'b.csv']);
    });
  });

  describe('getInputFiles / addInputFiles / clearInputFiles', () => {
    const file1 = {name: 'f1.txt', content: 'aGVsbG8=', encoding: undefined};
    const file2 = {name: 'f2.txt', content: 'd29ybGQ=', encoding: undefined};

    it('returns an empty array when no input files have been added', () => {
      const {ctx} = makeContext();
      expect(ctx.getInputFiles()).toEqual([]);
    });

    it('returns added input files', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([file1]);
      expect(ctx.getInputFiles()).toEqual([file1]);
    });

    it('appends on a second addInputFiles call', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([file1]);
      ctx.addInputFiles([file2]);
      expect(ctx.getInputFiles()).toHaveLength(2);
      expect(ctx.getInputFiles()[1]).toEqual(file2);
    });

    it('clearInputFiles empties the input files list', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([file1]);
      ctx.clearInputFiles();
      expect(ctx.getInputFiles()).toEqual([]);
    });

    it('clearInputFiles also resets processed file names', () => {
      const {ctx} = makeContext();
      ctx.addProcessedFileNames(['a.csv']);
      ctx.addInputFiles([file1]);
      ctx.clearInputFiles();
      expect(ctx.getProcessedFileNames()).toEqual([]);
    });

    it('clearInputFiles is a no-op when no files were added', () => {
      const {ctx} = makeContext();
      expect(() => ctx.clearInputFiles()).not.toThrow();
    });
  });

  describe('getErrorCount / incrementErrorCount / resetErrorCount', () => {
    it('returns 0 when error count has not been set', () => {
      const {ctx} = makeContext();
      expect(ctx.getErrorCount('inv-1')).toBe(0);
    });

    it('increments the error count from 0 to 1', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-1')).toBe(1);
    });

    it('increments the error count on successive calls', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-1')).toBe(3);
    });

    it('tracks error counts per invocation ID independently', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-2');
      ctx.incrementErrorCount('inv-2');
      expect(ctx.getErrorCount('inv-1')).toBe(1);
      expect(ctx.getErrorCount('inv-2')).toBe(2);
    });

    it('resetErrorCount brings the count back to 0', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-1');
      ctx.resetErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-1')).toBe(0);
    });

    it('resetErrorCount is a no-op when no counts have been recorded', () => {
      const {ctx} = makeContext();
      expect(() => ctx.resetErrorCount('inv-1')).not.toThrow();
      expect(ctx.getErrorCount('inv-1')).toBe(0);
    });

    it('resetErrorCount does not affect other invocation counts', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-2');
      ctx.resetErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-2')).toBe(1);
    });
  });

  describe('updateCodeExecutionResult', () => {
    it('stores a code execution result', () => {
      const {ctx, state} = makeContext();
      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'print("hi")',
        resultStdout: 'hi',
        resultStderr: '',
      });
      const results = state.get('_code_execution_results') as Record<
        string,
        unknown[]
      >;
      expect(results['inv-1']).toHaveLength(1);
      expect((results['inv-1'][0] as Record<string, unknown>)['code']).toBe(
        'print("hi")',
      );
    });

    it('appends a second result for the same invocation ID', () => {
      const {ctx, state} = makeContext();
      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'x = 1',
        resultStdout: '',
        resultStderr: '',
      });
      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'print(x)',
        resultStdout: '1',
        resultStderr: '',
      });
      const results = state.get('_code_execution_results') as Record<
        string,
        unknown[]
      >;
      expect(results['inv-1']).toHaveLength(2);
    });
  });

  describe('getCodeExecutionContext', () => {
    it('returns an empty object when no context has been set', () => {
      const {ctx} = makeContext();
      expect(ctx.getCodeExecutionContext()).toEqual({});
    });

    it('reflects mutations when state is pre-initialized with the context key', () => {
      // When the session state already has the context object, setExecutionId
      // mutates the same object reference so getCodeExecutionContext sees it.
      const contextObj: Record<string, unknown> = {};
      const state = new State({'_code_execution_context': contextObj});
      const ctx = new CodeExecutorContext(state);
      ctx.setExecutionId('s-42');
      const result = ctx.getCodeExecutionContext() as Record<string, unknown>;
      expect(result['execution_session_id']).toBe('s-42');
    });
  });
});
