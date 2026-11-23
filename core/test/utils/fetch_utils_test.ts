/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {FetchFunction} from '../../src/telemetry/api/instrumentation.js';
import {fetchWithTimeout} from '../../src/utils/fetch_utils.js';

/** A `fetch` that settles only when its request signal aborts. */
const stalledFetch: FetchFunction = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when the response headers do not arrive in time', async () => {
    const send = fetchWithTimeout({timeoutMs: 1000, fetchImpl: stalledFetch});

    const rejection = expect(send('https://peer.example.com/')).rejects.toThrow(
      'Request timed out after 1000 ms.',
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the response and stops the timer when the headers arrive in time', async () => {
    const response = new Response('pong');
    const fetchImpl = vi.fn<FetchFunction>().mockResolvedValue(response);
    const send = fetchWithTimeout({timeoutMs: 1000, fetchImpl});

    await expect(
      send('https://peer.example.com/', {method: 'POST'}),
    ).resolves.toBe(response);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://peer.example.com/',
      expect.objectContaining({method: 'POST'}),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the timer when the wrapped fetch rejects', async () => {
    const send = fetchWithTimeout({
      timeoutMs: 1000,
      fetchImpl: () => Promise.reject(new Error('Connection refused.')),
    });

    await expect(send('https://peer.example.com/')).rejects.toThrow(
      'Connection refused.',
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards an abort of the signal the caller passes', async () => {
    const caller = new AbortController();
    const send = fetchWithTimeout({timeoutMs: 1000, fetchImpl: stalledFetch});

    const rejection = expect(
      send('https://peer.example.com/', {signal: caller.signal}),
    ).rejects.toThrow('The caller cancelled the request.');
    caller.abort(new Error('The caller cancelled the request.'));

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still times out when the caller passes a signal', async () => {
    const send = fetchWithTimeout({timeoutMs: 1000, fetchImpl: stalledFetch});

    const rejection = expect(
      send('https://peer.example.com/', {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Request timed out after 1000 ms.');
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
  });

  it('does not fire at once for a timeout above the largest timer delay', async () => {
    const send = fetchWithTimeout({
      timeoutMs: 2 ** 40,
      fetchImpl: stalledFetch,
    });
    const caller = new AbortController();

    const rejection = expect(
      send('https://peer.example.com/', {signal: caller.signal}),
    ).rejects.toThrow('The caller cancelled the request.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(1);
    caller.abort(new Error('The caller cancelled the request.'));

    await rejection;
  });

  it('sends with the global fetch that is set when the request is made', async () => {
    const send = fetchWithTimeout({timeoutMs: 1000});
    const response = new Response('pong');
    const globalFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', globalFetch);

    try {
      await expect(send('https://peer.example.com/')).resolves.toBe(response);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
