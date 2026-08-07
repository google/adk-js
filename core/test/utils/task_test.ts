/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('task utils', () => {
  describe('Task class', () => {
    it('should initialize with done() returning false', () => {
      const task = new Task(() => new Promise<void>(() => {}));
      expect(task.done()).toBe(false);
    });

    it('should set done() to true when promise resolves', async () => {
      let resolvePromise!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });
      const task = new Task(() => promise);

      expect(task.done()).toBe(false);

      resolvePromise();
      await task.promise;

      expect(task.done()).toBe(true);
    });

    it('should set done() to true when promise rejects', async () => {
      let rejectPromise!: (err: Error) => void;
      const promise = new Promise<void>((_, reject) => {
        rejectPromise = reject;
      });
      const task = new Task(() => promise);

      expect(task.done()).toBe(false);

      rejectPromise(new Error('test error'));
      try {
        await task.promise;
      } catch (_) {
        // expected
      }
      // allow microtask queue to flush the .catch(markDone)
      await new Promise((resolve) => process.nextTick(resolve));

      expect(task.done()).toBe(true);
    });

    it('should trip abort signal when cancel is called', () => {
      let signal: AbortSignal | undefined;
      const task = new Task((s) => {
        signal = s;
        return new Promise<void>(() => {});
      });

      expect(signal?.aborted).toBe(false);
      task.cancel();
      expect(signal?.aborted).toBe(true);
    });
  });
});
