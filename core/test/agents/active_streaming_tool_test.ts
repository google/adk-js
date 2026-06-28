/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {ActiveStreamingTool} from '../../src/agents/active_streaming_tool.js';
import {LiveRequestQueue} from '../../src/agents/live_request_queue.js';

describe('ActiveStreamingTool', () => {
  it('should have undefined fields when constructed with no params', () => {
    const tool = new ActiveStreamingTool();
    expect(tool.task).toBeUndefined();
    expect(tool.stream).toBeUndefined();
  });

  it('should set task when constructed with only task param', () => {
    const task = Promise.resolve();
    const tool = new ActiveStreamingTool({task});
    expect(tool.task).toBe(task);
    expect(tool.stream).toBeUndefined();
  });

  it('should set stream when constructed with only stream param', () => {
    const stream = new LiveRequestQueue();
    const tool = new ActiveStreamingTool({stream});
    expect(tool.task).toBeUndefined();
    expect(tool.stream).toBe(stream);
  });

  it('should set both task and stream when both params are provided', () => {
    const task = Promise.resolve();
    const stream = new LiveRequestQueue();
    const tool = new ActiveStreamingTool({task, stream});
    expect(tool.task).toBe(task);
    expect(tool.stream).toBe(stream);
  });

  it('should allow fields to be read independently after construction', () => {
    const task = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const stream = new LiveRequestQueue();
    const tool = new ActiveStreamingTool({task, stream});

    const readTask = tool.task;
    const readStream = tool.stream;
    expect(readTask).toBe(task);
    expect(readStream).toBe(stream);
    expect(readStream).toBeInstanceOf(LiveRequestQueue);
  });
});
