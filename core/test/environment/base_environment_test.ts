/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseEnvironment, ExecutionResult} from '@google/adk';
import {describe, expect, it} from 'vitest';

const EMPTY_RESULT: ExecutionResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
};

/** Minimal concrete environment that relies on the base lifecycle defaults. */
class TestEnvironment extends BaseEnvironment {
  override get workingDir(): string {
    return '/test';
  }

  override async execute(): Promise<ExecutionResult> {
    this.assertInitialized();
    return EMPTY_RESULT;
  }

  override async readFile(): Promise<Uint8Array> {
    this.assertInitialized();
    return new Uint8Array();
  }

  override async writeFile(): Promise<void> {
    this.assertInitialized();
  }
}

/** An environment that owns the initialized flag, as real subclasses do. */
class InitializingTestEnvironment extends TestEnvironment {
  override async initialize(): Promise<void> {
    this.initialized = true;
  }
}

describe('BaseEnvironment', () => {
  it('is not initialized when constructed', () => {
    expect(new TestEnvironment().isInitialized).toBe(false);
  });

  it('leaves isInitialized false when the default initialize() runs', async () => {
    const env = new TestEnvironment();

    await env.initialize();

    expect(env.isInitialized).toBe(false);
  });

  it('resolves the default close() without throwing', async () => {
    await expect(new TestEnvironment().close()).resolves.toBeUndefined();
  });

  it('rejects operations until a subclass marks it initialized', async () => {
    const env = new InitializingTestEnvironment();

    await expect(env.execute()).rejects.toThrow(
      'Environment is not initialized. Call initialize() first.',
    );

    await env.initialize();

    expect(env.isInitialized).toBe(true);
    await expect(env.execute()).resolves.toEqual(EMPTY_RESULT);
  });
});
