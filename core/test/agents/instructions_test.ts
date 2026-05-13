/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {injectSessionState} from '../../src/agents/instructions.js';
import {InvocationContext, ReadonlyContext} from '@google/adk';

/**
 * Builds a minimal ReadonlyContext backed by a plain-object invocation context.
 * Only the fields accessed by injectSessionState are populated.
 */
function makeContext(
  state: Record<string, unknown> = {},
  artifactService?: unknown,
): ReadonlyContext {
  const fakeInvocationContext = {
    session: {
      id: 'sess-1',
      appName: 'app',
      userId: 'user-1',
      state,
    },
    artifactService,
  } as unknown as InvocationContext;

  return new ReadonlyContext(fakeInvocationContext);
}

describe('injectSessionState', () => {
  it('returns plain string unchanged when no placeholders present', async () => {
    const ctx = makeContext();
    expect(await injectSessionState('Hello world', ctx)).toBe('Hello world');
  });

  it('replaces {key} with matching value from session state', async () => {
    const ctx = makeContext({name: 'Alice'});
    expect(await injectSessionState('Hello {name}!', ctx)).toBe('Hello Alice!');
  });

  it('replaces multiple distinct keys in one template', async () => {
    const ctx = makeContext({greeting: 'Hi', user: 'Bob'});
    expect(await injectSessionState('{greeting}, {user}!', ctx)).toBe(
      'Hi, Bob!',
    );
  });

  it('coerces numeric state values to string', async () => {
    const ctx = makeContext({count: 42});
    expect(await injectSessionState('count={count}', ctx)).toBe('count=42');
  });

  it('replaces optional {key?} with value when key exists', async () => {
    const ctx = makeContext({title: 'Dr.'});
    expect(await injectSessionState('Hello {title?} Smith', ctx)).toBe(
      'Hello Dr. Smith',
    );
  });

  it('replaces optional {key?} with empty string when key is absent', async () => {
    const ctx = makeContext({});
    expect(await injectSessionState('Hello {title?}Smith', ctx)).toBe(
      'Hello Smith',
    );
  });

  it('throws when required {key} is absent from state', async () => {
    const ctx = makeContext({});
    await expect(injectSessionState('Hello {missing}', ctx)).rejects.toThrow(
      'Context variable not found: `missing`',
    );
  });

  it('treats {{double_brace}} as a placeholder, replacing inner key from state', async () => {
    const ctx = makeContext({double_brace: 'replaced'});
    // Pattern /\{+[^{}]*}+/ matches {{double_brace}} and extracts key "double_brace"
    expect(await injectSessionState('escape {{double_brace}}', ctx)).toBe(
      'escape replaced',
    );
  });

  it('passes through keys containing spaces (not valid identifiers)', async () => {
    const ctx = makeContext({});
    expect(await injectSessionState('value={invalid key}', ctx)).toBe(
      'value={invalid key}',
    );
  });

  it('replaces app: prefixed keys', async () => {
    const ctx = makeContext({'app:theme': 'dark'});
    expect(await injectSessionState('theme={app:theme}', ctx)).toBe(
      'theme=dark',
    );
  });

  it('replaces user: prefixed keys', async () => {
    const ctx = makeContext({'user:lang': 'en'});
    expect(await injectSessionState('lang={user:lang}', ctx)).toBe('lang=en');
  });

  it('replaces temp: prefixed keys', async () => {
    const ctx = makeContext({'temp:scratch': 'value'});
    expect(await injectSessionState('scratch={temp:scratch}', ctx)).toBe(
      'scratch=value',
    );
  });

  describe('artifact injection', () => {
    it('loads artifact when {artifact.filename} pattern used', async () => {
      const fakeArtifact = 'artifact content here';
      const mockArtifactService = {
        loadArtifact: vi.fn().mockResolvedValue(fakeArtifact),
      };

      const ctx = makeContext({}, mockArtifactService);
      const result = await injectSessionState(
        'data={artifact.report.txt}',
        ctx,
      );
      expect(result).toBe('data=artifact content here');
      expect(mockArtifactService.loadArtifact).toHaveBeenCalledWith({
        appName: 'app',
        userId: 'user-1',
        sessionId: 'sess-1',
        filename: 'report.txt',
      });
    });

    it('throws when artifact service is not initialised', async () => {
      const ctx = makeContext({}, undefined);
      await expect(
        injectSessionState('{artifact.report.txt}', ctx),
      ).rejects.toThrow('Artifact service is not initialized.');
    });

    it('throws when artifact is not found', async () => {
      const mockArtifactService = {
        loadArtifact: vi.fn().mockResolvedValue(null),
      };

      const ctx = makeContext({}, mockArtifactService);
      await expect(
        injectSessionState('{artifact.missing.txt}', ctx),
      ).rejects.toThrow('Artifact missing.txt not found.');
    });
  });
});
