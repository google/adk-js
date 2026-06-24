/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('task utils', () => {
  describe('Task class', () => {
    it('should initialize with done() returning false', () => {
      const promise = new Promise<void>(() => {});
      const task = new Task(promise);
      expect(task.done()).toBe(false);
    });

    it('should set done() to true when promise resolves', async () => {
      const promise = Promise.resolve();
      const task = new Task(promise);

      expect(task.done()).toBe(false);

      await promise;

      expect(task.done()).toBe(true);
    });

    it('should set done() to true when promise rejects', async () => {
      const promise = Promise.reject(new Error('test error'));
      const task = new Task(promise);

      expect(task.done()).toBe(false);

      try {
        await promise;
      } catch (_) {
        // expected
      }

      expect(task.done()).toBe(true);
    });

    it('should call cancelFn when cancel is called', () => {
      const cancelFn = vi.fn();
      const promise = new Promise<void>(() => {});
      const task = new Task(promise, cancelFn);

      task.cancel();

      expect(cancelFn).toHaveBeenCalledTimes(1);
    });

    it('should not throw if cancel is called but no cancelFn is provided', () => {
      const promise = new Promise<void>(() => {});
      const task = new Task(promise);

      expect(() => task.cancel()).not.toThrow();
    });
  });
});
