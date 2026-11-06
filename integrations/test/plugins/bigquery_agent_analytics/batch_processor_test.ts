/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  type AppendResult,
  BatchProcessor,
} from '../../../src/plugins/bigquery_agent_analytics/batch_processor.js';
import type {EventRow} from '../../../src/plugins/bigquery_agent_analytics/event_schema.js';

function createDummyRow(eventType: string, id: string = 'row-1'): EventRow {
  return {
    timestamp: new Date(),
    event_id: id,
    event_type: eventType,
    agent: 'test_agent',
    session_id: 's1',
    invocation_id: 'inv1',
    user_id: 'u1',
    trace_id: 't1',
    span_id: 'sp1',
    parent_span_id: null,
    content: null,
    content_parts: [],
    attributes: '{}',
    latency_ms: null,
    status: 'OK',
    error_message: null,
    is_truncated: false,
  };
}

describe('BatchProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a batch immediately when batchSize is reached', async () => {
    const writtenBatches: EventRow[][] = [];
    const processor = new BatchProcessor({
      batchSize: 2,
      writeRows: async (rows) => {
        writtenBatches.push([...rows]);
        return {};
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    expect(writtenBatches.length).toBe(0);

    processor.append(createDummyRow('LLM_RESPONSE', 'r2'));
    await processor.flush();

    expect(writtenBatches.length).toBe(1);
    expect(writtenBatches[0].map((r) => r.event_id)).toEqual(['r1', 'r2']);
  });

  it('flushes partial batch when flushInterval expires', async () => {
    const writtenBatches: EventRow[][] = [];
    const processor = new BatchProcessor({
      batchSize: 10,
      flushInterval: 1.0,
      writeRows: async (rows) => {
        writtenBatches.push([...rows]);
        return {};
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    expect(writtenBatches.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(writtenBatches.length).toBe(1);
    expect(writtenBatches[0][0].event_id).toBe('r1');
  });

  it('flush waits for in-flight write to complete', async () => {
    let writeStarted = false;
    let writeFinish: (() => void) | undefined;
    const writePromise = new Promise<AppendResult>((resolve) => {
      writeFinish = () => resolve({});
    });

    const processor = new BatchProcessor({
      batchSize: 1,
      writeRows: async () => {
        writeStarted = true;
        return writePromise;
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    expect(writeStarted).toBe(true);

    let flushDone = false;
    const flushOp = processor.flush().then(() => {
      flushDone = true;
    });

    expect(flushDone).toBe(false);
    writeFinish?.();
    await flushOp;
    expect(flushDone).toBe(true);
  });

  it('retries on retryable in-band response error codes with configured backoff', async () => {
    let attempts = 0;
    const sleepDelays: number[] = [];

    const processor = new BatchProcessor({
      batchSize: 1,
      retryConfig: {
        maxRetries: 3,
        initialDelay: 1.0,
        multiplier: 2.0,
        maxDelay: 10.0,
      },
      random: () => 0.5,
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
      writeRows: async () => {
        attempts += 1;
        // In-band error code 14: UNAVAILABLE
        return {
          error: {
            code: 14,
            message: 'Service unavailable in-band',
          },
        };
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    await processor.flush();

    // 1 initial attempt + 3 retries = 4 attempts total
    expect(attempts).toBe(4);
    expect(processor.getDropStats().retry_exhausted).toBe(1);

    // Initial delay 1.0 * (1 + 0.5) = 1.5s -> 1500ms
    // Second delay 2.0 * (1 + 0.5) = 3.0s -> 3000ms
    // Third delay 4.0 * (1 + 0.5) = 6.0s -> 6000ms
    expect(sleepDelays).toEqual([1500, 3000, 6000]);
  });

  it('retries on thrown gRPC retryable errors', async () => {
    let attempts = 0;
    const processor = new BatchProcessor({
      batchSize: 1,
      retryConfig: {
        maxRetries: 2,
        initialDelay: 0.1,
        multiplier: 2.0,
        maxDelay: 1.0,
      },
      sleep: async () => {},
      writeRows: async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('Resource exhausted');
          (err as {code?: number}).code = 8;
          throw err;
        }
        return {};
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    await processor.flush();

    expect(attempts).toBe(2);
    expect(processor.getDropStats().retry_exhausted).toBe(0);
  });

  it('retries on attempt timeout of 30 seconds', async () => {
    let attempts = 0;
    const processor = new BatchProcessor({
      batchSize: 1,
      retryConfig: {
        maxRetries: 1,
        initialDelay: 0.1,
        multiplier: 2.0,
        maxDelay: 1.0,
      },
      sleep: async () => {},
      writeRows: async () => {
        attempts += 1;
        if (attempts === 1) {
          // Never resolve (hang)
          return new Promise<never>(() => {});
        }
        return {};
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    const flushPromise = processor.flush();

    // Advance 30 seconds to trigger attempt timeout
    await vi.advanceTimersByTimeAsync(30000);
    await flushPromise;

    expect(attempts).toBe(2);
    expect(processor.getDropStats().retry_exhausted).toBe(0);
  });

  it('drops batch without retry on permission_denied (code 7)', async () => {
    let attempts = 0;
    const processor = new BatchProcessor({
      batchSize: 1,
      writeRows: async () => {
        attempts += 1;
        return {
          error: {
            code: 7,
            message: 'Permission denied',
          },
        };
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    await processor.flush();

    expect(attempts).toBe(1);
    expect(processor.getDropStats().permission_denied).toBe(1);
  });

  it('drops batch without retry on not_found (code 5)', async () => {
    let attempts = 0;
    const processor = new BatchProcessor({
      batchSize: 1,
      writeRows: async () => {
        attempts += 1;
        return {
          error: {
            code: 5,
            message: 'Table not found',
          },
        };
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    await processor.flush();

    expect(attempts).toBe(1);
    expect(processor.getDropStats().not_found).toBe(1);
  });

  it('drops batch on non_retryable errors (code 3 / invalid argument)', async () => {
    let attempts = 0;
    const processor = new BatchProcessor({
      batchSize: 1,
      writeRows: async () => {
        attempts += 1;
        return {
          error: {
            code: 3,
            message: 'Invalid argument',
          },
        };
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    await processor.flush();

    expect(attempts).toBe(1);
    expect(processor.getDropStats().non_retryable).toBe(1);
  });

  it('drops batch on unexpected errors', async () => {
    let attempts = 0;
    const processor = new BatchProcessor({
      batchSize: 1,
      writeRows: async () => {
        attempts += 1;
        throw new Error('Something completely unexpected');
      },
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    await processor.flush();

    expect(attempts).toBe(1);
    expect(processor.getDropStats().unexpected_error).toBe(1);
  });

  it('preserves reserved terminal slots for INVOCATION_COMPLETED', async () => {
    const processor = new BatchProcessor({
      queueMaxSize: 10,
      batchSize: 20, // keep items queued without writing
      writeRows: async () => ({}),
    });

    // queueMaxSize=10, reservedTerminalSlots = min(max(2, 0), 9) = 2 slots.
    // Non-terminal rows can fill up to 8 slots (10 - 2 = 8).
    for (let i = 1; i <= 8; i++) {
      processor.append(createDummyRow('LLM_REQUEST', `r${i}`));
    }
    expect(processor.getDropStats().queue_full).toBe(0);

    // 9th non-terminal row must be dropped
    processor.append(createDummyRow('LLM_REQUEST', 'r9'));
    expect(processor.getDropStats().queue_full).toBe(1);

    // Terminal row must be accepted into reserved slots
    processor.append(createDummyRow('INVOCATION_COMPLETED', 'term1'));
    expect(processor.getDropStats().queue_full).toBe(1);
  });

  it('shuts down cleanly, counting abandoned rows on timeout and drops after shutdown', async () => {
    let writeFinish: (() => void) | undefined;
    const writePromise = new Promise<AppendResult>((resolve) => {
      writeFinish = () => resolve({});
    });

    const processor = new BatchProcessor({
      batchSize: 5,
      shutdownTimeout: 2.0,
      writeRows: async () => writePromise,
    });

    processor.append(createDummyRow('LLM_REQUEST', 'r1'));
    processor.append(createDummyRow('LLM_REQUEST', 'r2'));

    // Trigger shutdown with short timeout
    const shutdownPromise = processor.shutdown(2.0);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(2500);
    await shutdownPromise;

    expect(processor.getDropStats().shutdown_timeout).toBeGreaterThan(0);

    // Appends after shutdown are rejected as shutdown_cancelled
    processor.append(createDummyRow('LLM_REQUEST', 'r-after'));
    expect(processor.getDropStats().shutdown_cancelled).toBe(1);

    // Shutdown is idempotent
    await expect(processor.shutdown()).resolves.toBeUndefined();
    writeFinish?.();
  });
});
