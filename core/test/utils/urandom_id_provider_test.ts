/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  generateClientFunctionCallId,
  InMemorySessionService,
  logger,
  newId,
  resetIdProvider,
  setIdProvider,
  urandomIdProvider,
} from '@google/adk';
import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {newInvocationContextId} from '../../src/agents/invocation_context.js';
import {
  createUrandomIdProvider,
  readUrandom,
} from '../../src/utils/id_provider.js';

const UUID_V4_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4 = new RegExp(`^${UUID_V4_PATTERN}$`);
const INVOCATION_ID = new RegExp(`^e-${UUID_V4_PATTERN}$`);
const FUNCTION_CALL_ID = new RegExp(`^adk-${UUID_V4_PATTERN}$`);
const EVENT_ID = /^[A-Za-z0-9]{8}$/;

// What crypto.randomUUID() returns in every clone of one memory snapshot.
const SNAPSHOT_UUID = '11111111-1111-4111-8111-111111111111';

const hasDevUrandom = process.platform !== 'win32';

// The v4 UUID that 16 bytes become: version and variant bits set.
function toUuid(source: Uint8Array): string {
  const bytes = Uint8Array.from(source.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A random source that hands out the bytes 0, 1, 2, ... in order.
function countingSource() {
  let next = 0;
  const source = {
    reads: 0,
    read: (bytes: Uint8Array) => {
      source.reads++;
      for (let i = 0; i < bytes.length; i++) bytes[i] = next++ & 0xff;
    },
  };
  return source;
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), {code});
}

function silenceWarnings() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  resetIdProvider();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('setIdProvider(urandomIdProvider)', () => {
  it.runIf(hasDevUrandom)(
    'mints each id from 16 fresh bytes of /dev/urandom, not from crypto.randomUUID',
    () => {
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(SNAPSHOT_UUID);
      const read = vi.spyOn(fs, 'readSync');
      setIdProvider(urandomIdProvider);

      const ids = [newId(), newId()];

      // `fs.readSync` is overloaded; the provider uses the
      // (fd, buffer, offset, length, position) form.
      const calls = read.mock.calls as unknown as Array<
        [number, Uint8Array, number, number, null]
      >;
      expect(calls.map((call) => call[3])).toEqual([16, 16]);
      expect(ids).toEqual(calls.map((call) => toUuid(call[1])));
      expect(ids).not.toContain(SNAPSHOT_UUID);
      expect(ids[0]).not.toBe(ids[1]);
    },
  );

  it.runIf(hasDevUrandom)(
    'opens and closes /dev/urandom for every id, so no descriptor stays open',
    () => {
      const open = vi.spyOn(fs, 'openSync');
      const close = vi.spyOn(fs, 'closeSync');
      setIdProvider(urandomIdProvider);

      newId();
      newId();

      expect(open.mock.calls).toEqual([
        ['/dev/urandom', 'r'],
        ['/dev/urandom', 'r'],
      ]);
      expect(close.mock.calls.map((call) => call[0])).toEqual(
        open.mock.results.map((result) => result.value),
      );
    },
  );

  it.runIf(hasDevUrandom)('logs no warning where /dev/urandom exists', () => {
    const warn = silenceWarnings();
    setIdProvider(urandomIdProvider);

    newId();

    expect(warn).not.toHaveBeenCalled();
  });

  it('drives event, invocation, function-call and session ids', async () => {
    silenceWarnings();
    setIdProvider(urandomIdProvider);

    const session = await new InMemorySessionService().createSession({
      appName: 'app',
      userId: 'user',
    });

    expect(createEvent().id).toMatch(UUID_V4);
    expect(newInvocationContextId()).toMatch(INVOCATION_ID);
    expect(generateClientFunctionCallId()).toMatch(FUNCTION_CALL_ID);
    expect(session.id).toMatch(UUID_V4);
  });

  it('is replaced by a provider installed after it', () => {
    setIdProvider(urandomIdProvider);
    setIdProvider(() => 'vm-1');

    expect(newId()).toBe('vm-1');
  });

  it('stops after resetIdProvider(), so event ids go back to 8 characters', () => {
    setIdProvider(urandomIdProvider);
    resetIdProvider();
    const read = vi.spyOn(fs, 'readSync');

    expect(createEvent().id).toMatch(EVENT_ID);
    expect(read).not.toHaveBeenCalled();
  });

  it.runIf(!hasDevUrandom)(
    'falls back to crypto.randomUUID with one warning on Windows',
    () => {
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(SNAPSHOT_UUID);
      const warn = silenceWarnings();
      // A fresh provider: the exported one is shared by the whole process, so
      // an earlier test may already have logged its warning.
      const provider = createUrandomIdProvider();

      expect([provider(), provider()]).toEqual([SNAPSHOT_UUID, SNAPSHOT_UUID]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('ENOENT');
    },
  );
});

describe('createUrandomIdProvider', () => {
  it('builds a v4 UUID from 16 bytes of the source', () => {
    const provider = createUrandomIdProvider(countingSource().read);

    // Bytes 0x00..0x0f, with the version nibble of byte 6 set to 4 and the
    // variant bits of byte 8 set to 10.
    expect(provider()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('reads the source again for every id', () => {
    const source = countingSource();
    const provider = createUrandomIdProvider(source.read);

    provider();
    provider();
    provider();

    expect(source.reads).toBe(3);
  });

  for (const code of [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ERR_ACCESS_DENIED',
    'ERR_ADK_NO_FS',
  ]) {
    it(`uses the fallback from then on after a permanent ${code} error`, () => {
      silenceWarnings();
      let reads = 0;
      const provider = createUrandomIdProvider(
        () => {
          reads++;
          throw errorWithCode(code);
        },
        () => 'fallback-id',
      );

      expect([provider(), provider()]).toEqual(['fallback-id', 'fallback-id']);
      expect(reads).toBe(1);
    });
  }

  it('uses the fallback from then on when Deno has no read permission', () => {
    silenceWarnings();
    let reads = 0;
    const provider = createUrandomIdProvider(
      () => {
        reads++;
        throw Object.assign(new Error('Requires read access'), {
          name: 'NotCapable',
        });
      },
      () => 'fallback-id',
    );

    provider();
    provider();

    expect(reads).toBe(1);
  });

  it('uses the fallback for one id only after a temporary error such as EMFILE', () => {
    silenceWarnings();
    let reads = 0;
    const provider = createUrandomIdProvider(
      (bytes) => {
        reads++;
        if (reads === 1) throw errorWithCode('EMFILE');
        bytes.fill(0);
      },
      () => 'fallback-id',
    );

    expect(provider()).toBe('fallback-id');
    expect(provider()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('warns once, naming the cause, however many ids fall back', () => {
    const warn = silenceWarnings();
    const provider = createUrandomIdProvider(
      () => {
        throw errorWithCode('EMFILE');
      },
      () => 'fallback-id',
    );

    provider();
    provider();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EMFILE');
  });

  it('does not warn outside a server runtime, where no snapshot clones the page', () => {
    const warn = silenceWarnings();
    const provider = createUrandomIdProvider(
      () => {
        throw errorWithCode('ERR_ADK_NO_FS');
      },
      () => 'fallback-id',
      () => false,
    );

    expect(provider()).toBe('fallback-id');
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts Node as a server runtime by default, so the fallback warns', () => {
    const warn = silenceWarnings();
    const provider = createUrandomIdProvider(
      () => {
        throw errorWithCode('ERR_ADK_NO_FS');
      },
      () => 'fallback-id',
    );

    provider();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn by default where there is no process, as in a browser or worker', () => {
    vi.stubGlobal('process', undefined);
    const warn = silenceWarnings();
    const provider = createUrandomIdProvider(
      () => {
        throw errorWithCode('ERR_ADK_NO_FS');
      },
      () => 'fallback-id',
    );

    provider();

    vi.unstubAllGlobals();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('readUrandom', () => {
  it('opens /dev/urandom read-only, fills the buffer over short reads, and closes it', () => {
    const chunks = [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10, 11, 12, 13, 14],
      [15, 16],
    ];
    const lengths: number[] = [];
    const closed: number[] = [];
    const fakeFs = {
      openSync: (path: string, flags: string) => {
        expect([path, flags]).toEqual(['/dev/urandom', 'r']);
        return 7;
      },
      readSync: (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
      ) => {
        expect(fd).toBe(7);
        lengths.push(length);
        const chunk = chunks.shift()!;
        buffer.set(chunk, offset);
        return chunk.length;
      },
      closeSync: (fd: number) => {
        closed.push(fd);
      },
    };
    const bytes = new Uint8Array(16);

    readUrandom(bytes, fakeFs);

    expect(Array.from(bytes)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(lengths).toEqual([16, 11, 2]);
    expect(closed).toEqual([7]);
  });

  it('throws when a read returns no bytes, and still closes the file', () => {
    const closed: number[] = [];
    const fakeFs = {
      openSync: () => 7,
      readSync: () => 0,
      closeSync: (fd: number) => {
        closed.push(fd);
      },
    };

    expect(() => readUrandom(new Uint8Array(16), fakeFs)).toThrow(
      /\/dev\/urandom/,
    );
    expect(closed).toEqual([7]);
  });

  it('throws ERR_ADK_NO_FS when there is no Node fs module', () => {
    expect(() => readUrandom(new Uint8Array(16), null)).toThrow(
      expect.objectContaining({code: 'ERR_ADK_NO_FS'}),
    );
  });

  it('finds no fs module on a Node without process.getBuiltinModule', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);

    expect(() => readUrandom(new Uint8Array(16))).toThrow(
      expect.objectContaining({code: 'ERR_ADK_NO_FS'}),
    );
  });

  it.runIf(hasDevUrandom)(
    'reads different bytes from the real /dev/urandom on each call',
    () => {
      const a = new Uint8Array(16);
      const b = new Uint8Array(16);

      readUrandom(a);
      readUrandom(b);

      expect(Array.from(a)).not.toEqual(Array.from(b));
    },
  );

  it.runIf(!hasDevUrandom)(
    'throws ENOENT on Windows, which has no /dev/urandom',
    () => {
      expect(() => readUrandom(new Uint8Array(16))).toThrow(
        expect.objectContaining({code: 'ENOENT'}),
      );
    },
  );
});
