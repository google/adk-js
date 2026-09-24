/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  EnforcementMode,
  Event,
  InvocationContext,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  ToolCallIntegrityError,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeContext(events: Event[] = []): InvocationContext {
  return {
    session: {
      id: 'session-1',
      appName: 'app',
      userId: 'user',
      state: {},
      events,
      lastUpdateTime: 0,
    },
  } as unknown as InvocationContext;
}

function makeEvent(...functionCalls: FunctionCall[]): Event {
  return createEvent({
    invocationId: 'inv-1',
    author: 'agent',
    content: {
      role: 'model',
      parts: functionCalls.map((functionCall) => ({functionCall})),
    },
  });
}

function confirmationCall(
  id = 'fc-1',
  args: Record<string, unknown> = {amount: 100, to: 'alice'},
): FunctionCall {
  return {id, name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, args};
}

/** Mints HMACs on the given events and returns a context holding them. */
async function stamp(
  plugin: ToolCallIntegrityPlugin,
  ...events: Event[]
): Promise<InvocationContext> {
  const context = makeContext(events);
  for (const event of events) {
    await plugin.onEventCallback({invocationContext: context, event});
  }
  return context;
}

describe('ToolCallIntegrityPlugin', () => {
  describe('constructor', () => {
    it('uses the default name', () => {
      expect(new ToolCallIntegrityPlugin({secretKey: 'k'}).name).toBe(
        'tool_call_integrity',
      );
    });

    it.each([[''], [[]], [['a', '']], [new Uint8Array()]])(
      'rejects empty keys: %j',
      (secretKey) => {
        expect(() => new ToolCallIntegrityPlugin({secretKey})).toThrow(
          'secretKey must be a non-empty key or list of keys',
        );
      },
    );
  });

  describe('onEventCallback', () => {
    it('stamps HITL calls and keeps existing metadata', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const event = makeEvent(confirmationCall('fc-1'), {
        id: 'fc-2',
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        args: {prompt: 'name?'},
      });
      event.customMetadata = {existing: true};

      const result = await plugin.onEventCallback({
        invocationContext: makeContext(),
        event,
      });

      expect(result).toBeUndefined();
      expect(event.customMetadata!['existing']).toBe(true);
      const hmacs = event.customMetadata!['_hitl_hmac'] as Record<
        string,
        string
      >;
      expect(Object.keys(hmacs).sort()).toEqual(['fc-1', 'fc-2']);
      expect(hmacs['fc-1']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ignores non-HITL calls and calls without an id', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const event = makeEvent(
        {id: 'fc-1', name: 'transfer', args: {}},
        {name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, args: {}},
      );

      await plugin.onEventCallback({invocationContext: makeContext(), event});

      expect(event.customMetadata).toBeUndefined();
    });

    it('is deterministic regardless of key order and null values', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const a = makeEvent(confirmationCall('fc', {b: 1, a: {y: 2, x: 1}}));
      const b = makeEvent(
        confirmationCall('fc', {a: {x: 1, y: 2, z: null}, b: 1.0}),
      );
      await stamp(plugin, a, b);

      expect(a.customMetadata).toEqual(b.customMetadata);
    });

    it('binds the HMAC to the session identity', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const event = makeEvent(confirmationCall());
      const context = await stamp(plugin, event);
      context.session.id = 'other-session';

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).rejects.toThrow(/HMAC mismatch/);
    });
  });

  describe('beforeRunCallback', () => {
    it('accepts untampered calls', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const context = await stamp(
        plugin,
        makeEvent(confirmationCall('fc-1')),
        makeEvent({id: 'fc-2', name: 'regular_tool', args: {}}),
      );

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).resolves.toBeUndefined();
    });

    it('rejects tampered arguments', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const event = makeEvent(confirmationCall());
      const context = await stamp(plugin, event);
      event.content!.parts![0].functionCall!.args = {amount: 1e6, to: 'eve'};

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).rejects.toThrow(ToolCallIntegrityError);
    });

    it('rejects a forged or malformed HMAC', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      for (const forged of ['00'.repeat(32), 'not-hex', 42]) {
        const event = makeEvent(confirmationCall());
        event.customMetadata = {_hitl_hmac: {'fc-1': forged}};

        await expect(
          plugin.beforeRunCallback({invocationContext: makeContext([event])}),
        ).rejects.toThrow(/HMAC mismatch/);
      }
    });

    it('rejects stamps minted with a different key', async () => {
      const event = makeEvent(confirmationCall());
      const context = await stamp(
        new ToolCallIntegrityPlugin({secretKey: 'attacker'}),
        event,
      );

      await expect(
        new ToolCallIntegrityPlugin({secretKey: 'k'}).beforeRunCallback({
          invocationContext: context,
        }),
      ).rejects.toThrow(/HMAC mismatch/);
    });

    it('rejects a renamed call whose stamp is orphaned', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const event = makeEvent(confirmationCall());
      const context = await stamp(plugin, event);
      event.content!.parts![0].functionCall!.name = 'transfer';

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).rejects.toThrow(/have no matching HITL function call/);
    });

    it('rejects a missing stamp in block mode', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
      const context = makeContext([makeEvent(confirmationCall())]);

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).rejects.toThrow(/Missing HMAC/);
    });

    it('tolerates a missing stamp in shadow mode', async () => {
      const plugin = new ToolCallIntegrityPlugin({
        secretKey: 'k',
        enforcement: EnforcementMode.SHADOW_MODE,
      });
      const context = makeContext([makeEvent(confirmationCall())]);

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).resolves.toBeUndefined();
    });

    it('still rejects tampering in shadow mode', async () => {
      const plugin = new ToolCallIntegrityPlugin({
        secretKey: 'k',
        enforcement: EnforcementMode.SHADOW_MODE,
      });
      const event = makeEvent(confirmationCall());
      const context = await stamp(plugin, event);
      event.content!.parts![0].functionCall!.args = {amount: 1};

      await expect(
        plugin.beforeRunCallback({invocationContext: context}),
      ).rejects.toThrow(/HMAC mismatch/);
    });
  });

  describe('key rotation', () => {
    it('validates stamps minted with an old key', async () => {
      const event = makeEvent(confirmationCall());
      const context = await stamp(
        new ToolCallIntegrityPlugin({secretKey: 'old'}),
        event,
      );
      const rotated = new ToolCallIntegrityPlugin({secretKey: ['new', 'old']});

      await expect(
        rotated.beforeRunCallback({invocationContext: context}),
      ).resolves.toBeUndefined();
    });

    it('mints with the first key', async () => {
      const rotatedEvent = makeEvent(confirmationCall());
      const newEvent = makeEvent(confirmationCall());
      await stamp(
        new ToolCallIntegrityPlugin({secretKey: ['new', 'old']}),
        rotatedEvent,
      );
      await stamp(new ToolCallIntegrityPlugin({secretKey: 'new'}), newEvent);

      expect(rotatedEvent.customMetadata).toEqual(newEvent.customMetadata);
    });

    it('treats string and byte keys identically', async () => {
      const a = makeEvent(confirmationCall());
      const b = makeEvent(confirmationCall());
      await stamp(new ToolCallIntegrityPlugin({secretKey: 'key'}), a);
      await stamp(
        new ToolCallIntegrityPlugin({
          secretKey: new TextEncoder().encode('key'),
        }),
        b,
      );

      expect(a.customMetadata).toEqual(b.customMetadata);
    });
  });

  it('exposes the original error as the cause through PluginManager', async () => {
    const plugin = new ToolCallIntegrityPlugin({secretKey: 'k'});
    const manager = new PluginManager([plugin]);
    const context = makeContext([makeEvent(confirmationCall())]);

    const error = await manager
      .runBeforeRunCallback({invocationContext: context})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeInstanceOf(ToolCallIntegrityError);
  });
});
