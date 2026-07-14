/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ActiveStreamingTool, LiveRequestQueue, Task} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ActiveStreamingTool E2E Simulation', () => {
  it('should manage a simulated streaming tool task', async () => {
    const queue = new LiveRequestQueue();
    // Simulate a background task using AbortSignal
    const task = new Task((signal) => {
      return new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (signal.aborted) {
            clearInterval(interval);
            resolve();
            return;
          }
          // Push some dummy data to the queue
          queue.sendContent({parts: [{text: 'data'}]});
        }, 10);
      });
    });

    const activeTool = new ActiveStreamingTool({task, stream: queue});

    expect(activeTool.task).toBe(task);
    expect(activeTool.stream).toBe(queue);
    expect(activeTool.task?.done()).toBe(false);

    // Let it run a bit to generate some data
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify queue got some data
    const nextItem = await queue.get();
    expect(nextItem).toBeDefined();
    expect(nextItem?.content?.parts?.[0]?.text).toBe('data');

    // Cancel it
    activeTool.task?.cancel();
    await task.promise;

    expect(activeTool.task?.done()).toBe(true);
  });
});
