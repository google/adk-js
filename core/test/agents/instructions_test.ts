/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext, ReadonlyContext} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {injectSessionState} from '../../src/agents/instructions.js';

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

  it('deduplicates state variable lookups', async () => {
    let accessCount = 0;
    const state = {
      get name() {
        accessCount++;
        return 'Alice';
      },
    };
    const ctx = makeContext(state);
    const result = await injectSessionState('Hello {name} and {name}!', ctx);
    expect(result).toBe('Hello Alice and Alice!');
    expect(accessCount).toBe(1);
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

  it('passes through keys with too many colons', async () => {
    const ctx = makeContext({});
    expect(await injectSessionState('value={a:b:c}', ctx)).toBe(
      'value={a:b:c}',
    );
  });

  it('passes through keys with invalid prefixes', async () => {
    const ctx = makeContext({});
    expect(await injectSessionState('value={invalid:key}', ctx)).toBe(
      'value={invalid:key}',
    );
  });

  it('passes through keys with valid prefix but invalid identifier', async () => {
    const ctx = makeContext({});
    expect(await injectSessionState('value={app:invalid key}', ctx)).toBe(
      'value={app:invalid key}',
    );
  });

  it('passes through empty placeholders', async () => {
    const ctx = makeContext({});
    expect(await injectSessionState('value={}', ctx)).toBe('value={}');
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

    it('resolves missing optional artifact to empty string', async () => {
      const mockArtifactService = {
        loadArtifact: vi.fn().mockResolvedValue(null),
      };

      const ctx = makeContext({}, mockArtifactService);
      const result = await injectSessionState('{artifact.missing.txt?}', ctx);
      expect(result).toBe('');
    });

    it('deduplicates artifact loads', async () => {
      const fakeArtifact = 'artifact content';
      const mockArtifactService = {
        loadArtifact: vi.fn().mockResolvedValue(fakeArtifact),
      };

      const ctx = makeContext({}, mockArtifactService);
      const result = await injectSessionState(
        'data={artifact.report.txt} and {artifact.report.txt}',
        ctx,
      );
      expect(result).toBe('data=artifact content and artifact content');
      expect(mockArtifactService.loadArtifact).toHaveBeenCalledTimes(1);
    });

    it('resolves artifacts concurrently', async () => {
      const delays: Record<string, number> = {
        'r1.txt': 50,
        'r2.txt': 50,
      };
      const callOrder: string[] = [];
      const mockArtifactService = {
        loadArtifact: vi.fn().mockImplementation(async ({filename}) => {
          callOrder.push(`start:${filename}`);
          await new Promise((resolve) => setTimeout(resolve, delays[filename]));
          callOrder.push(`end:${filename}`);
          return `content:${filename}`;
        }),
      };

      const ctx = makeContext({}, mockArtifactService);
      const result = await injectSessionState(
        '{artifact.r1.txt} and {artifact.r2.txt}',
        ctx,
      );
      expect(result).toBe('content:r1.txt and content:r2.txt');
      expect(callOrder[0]).toBe('start:r1.txt');
      expect(callOrder[1]).toBe('start:r2.txt');
    });
  });

  it('resolves mixed required and optional placeholders for the same key', async () => {
    const ctx = makeContext({'user:name': 'Alice'});
    expect(
      await injectSessionState('Hello {user:name} and {user:name?}!', ctx),
    ).toBe('Hello Alice and Alice!');
  });

  it('throws when mixed required and optional placeholders are missing the key', async () => {
    const ctx = makeContext({});
    await expect(
      injectSessionState('Hello {user:name} and {user:name?}!', ctx),
    ).rejects.toThrow('Context variable not found: `user:name`');
  });

  it('keeps invalid placeholders as-is even when mixed', async () => {
    const ctx = makeContext({});
    expect(
      await injectSessionState('Hello {invalid key?} and {invalid key}!', ctx),
    ).toBe('Hello {invalid key?} and {invalid key}!');
  });
});
