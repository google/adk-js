/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ActiveStreamingTool, Task} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ActiveStreamingTool', () => {
  it('should construct with default parameters', () => {
    const tool = new ActiveStreamingTool();
    expect(tool.task).toBeUndefined();
    expect(tool.stream).toBeUndefined();
  });

  it('should store task when constructed with one', () => {
    const promise = Promise.resolve();
    const task = new Task(() => promise);
    const tool = new ActiveStreamingTool({task});
    expect(tool.task).toBe(task);
  });
});
