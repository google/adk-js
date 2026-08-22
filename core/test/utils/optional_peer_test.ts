/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';

const PEER = {packageName: '@example/driver', feature: 'ExampleService'};

/** Builds the error Node raises for an unresolvable ESM specifier. */
function moduleNotFound(specifier: string, code: string): Error {
  const err = new Error(
    `Cannot find package '${specifier}' imported from /app/index.js`,
  ) as Error & {code?: string};
  err.code = code;
  return err;
}

describe('loadOptionalPeer', () => {
  it('returns the module when the peer is installed', async () => {
    const loaded = await loadOptionalPeer(PEER, async () => ({value: 42}));
    expect(loaded).toEqual({value: 42});
  });

  it.each(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])(
    'turns a %s into an error naming the feature and install command',
    async (code) => {
      const promise = loadOptionalPeer(PEER, () => {
        throw moduleNotFound('@example/driver', code);
      });

      await expect(promise).rejects.toThrow(/ExampleService requires/);
      await expect(promise).rejects.toThrow(/npm install @example\/driver/);
    },
  );

  it('keeps the original error as the cause', async () => {
    const original = moduleNotFound('@example/driver', 'ERR_MODULE_NOT_FOUND');

    await expect(
      loadOptionalPeer(PEER, () => Promise.reject(original)),
    ).rejects.toMatchObject({cause: original});
  });

  it('rethrows a failure that is not the peer being missing', async () => {
    // A module that resolves but throws while evaluating, or one whose own
    // transitive dependency is missing, must not be reported as "install the
    // peer" — that would send the caller after the wrong problem.
    const evaluationError = new Error('boom');

    await expect(
      loadOptionalPeer(PEER, () => Promise.reject(evaluationError)),
    ).rejects.toBe(evaluationError);
  });

  it('rethrows a module-not-found error for a different package', async () => {
    await expect(
      loadOptionalPeer(PEER, () =>
        Promise.reject(
          moduleNotFound('@example/something-else', 'ERR_MODULE_NOT_FOUND'),
        ),
      ),
    ).rejects.toThrow(/Cannot find package '@example\/something-else'/);
  });

  it('rethrows a module-not-found error for a missing SUBPATH of the peer', async () => {
    // The peer itself IS installed; one of its own deep imports could not be
    // resolved. The specifier contains the peer's name as a prefix, so a loose
    // substring match would misreport this as "install the peer" and hide the
    // real problem. Only a bare-specifier match of the peer must trigger the
    // friendly message.
    const subpathMissing = moduleNotFound(
      '@example/driver/build/internal.js',
      'ERR_MODULE_NOT_FOUND',
    );

    await expect(
      loadOptionalPeer(PEER, () => Promise.reject(subpathMissing)),
    ).rejects.toBe(subpathMissing);
  });
});
