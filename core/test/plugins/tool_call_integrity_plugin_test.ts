/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createEvent,
  createSession,
  Event,
  INTERNAL_METADATA_PREFIX,
  InvocationContext,
  markRestored,
  RESTORED_EVENT_KEY,
  ToolCallIntegrityError,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {TOOL_CALL_HMAC_METADATA_KEY as HMAC_KEY} from '../../src/plugins/tool_call_integrity_plugin.js';
import {logger} from '../../src/utils/logger.js';

const KEY = new TextEncoder().encode('test-secret-key');
const CONFIRM = 'adk_request_confirmation';
const STAMP_PREFIX = 'v1:';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function ctx(): InvocationContext {
  return {
    session: createSession({id: 'session', appName: 'app', userId: 'user'}),
  } as unknown as InvocationContext;
}

function event(
  calls: FunctionCall[],
  {author = 'agent', text = ''}: {author?: string; text?: string} = {},
): Event {
  return createEvent({
    invocationId: 'inv',
    author,
    content: {
      role: 'model',
      parts: [
        ...calls.map((functionCall) => ({functionCall})),
        ...(text ? [{text}] : []),
      ],
    },
  });
}

/** Pass `null` for a call without an ID. */
function fc(
  id: string | null = 'fc-1',
  name = CONFIRM,
  args: Record<string, unknown> = {amount: 10},
): FunctionCall {
  return {id: id ?? undefined, name, args: structuredClone(args)};
}

async function mint(
  plugin: ToolCallIntegrityPlugin,
  context: InvocationContext,
  e: Event,
): Promise<Event> {
  await plugin.onEventCallback({invocationContext: context, event: e});
  context.session.events.push(e);
  return e;
}

function validate(
  plugin: ToolCallIntegrityPlugin,
  context: InvocationContext,
): Promise<unknown> {
  return plugin.beforeRunCallback({invocationContext: context});
}

function callAt(context: InvocationContext, index = 0): FunctionCall {
  return context.session.events[index].content!.parts![0].functionCall!;
}

function stampsOf(e: Event): Record<string, string> {
  return e.customMetadata![HMAC_KEY] as Record<string, string>;
}

/** Sets the marker the way a store writer could, keeping other metadata. */
function setRestoredMarker(e: Event): Event {
  e.customMetadata = {...(e.customMetadata ?? {}), [RESTORED_EVENT_KEY]: true};
  return e;
}

function gate(
  plugin: ToolCallIntegrityPlugin,
  context: InvocationContext,
  {
    callId = 'fc-1',
    toolArgs = {amount: 10},
    name = CONFIRM,
  }: {
    callId?: string | null;
    toolArgs?: Record<string, unknown>;
    name?: string;
  } = {},
): Promise<Record<string, unknown> | undefined> {
  return plugin.beforeToolCallback({
    tool: {name} as BaseTool,
    toolArgs,
    toolContext: {
      functionCallId: callId ?? undefined,
      invocationContext: context,
    } as unknown as Context,
  });
}

const BOTH = [false, true];

describe('ToolCallIntegrityPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it.each([
      ['empty bytes', new Uint8Array()],
      ['empty list', []],
      ['list with empty key', [bytes('good'), new Uint8Array()]],
      ['string', 'str-key'],
      ['list with string', [bytes('good'), 'str-key']],
    ])('rejects %s', (_label, secretKey) => {
      expect(
        () =>
          new ToolCallIntegrityPlugin({
            secretKey: secretKey as unknown as Uint8Array,
          }),
      ).toThrow('non-empty bytes');
    });

    it('copies the key so later changes to the buffer do not apply', async () => {
      const key = bytes('mutable-key');
      const plugin = new ToolCallIntegrityPlugin({secretKey: key});
      const context = ctx();
      await mint(plugin, context, event([fc()]));

      key.fill(0);

      await validate(plugin, context);
    });
  });

  describe('stamping', () => {
    it('stamps every function call', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const e = await mint(
        plugin,
        ctx(),
        event([
          fc('fc-1'),
          fc('fc-2', 'adk_request_input'),
          fc('fc-3', 'transfer_money'),
        ]),
      );

      const stamps = stampsOf(e);
      expect(Object.keys(stamps).sort()).toEqual(['fc-1', 'fc-2', 'fc-3']);
      expect(new Set(Object.values(stamps)).size).toBe(3);
      for (const stamp of Object.values(stamps)) {
        expect(stamp).toMatch(/^v1:[0-9a-f]{64}$/);
      }
    });

    it('ignores events without calls', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const e = await mint(plugin, ctx(), event([], {text: 'hello'}));

      expect(e.customMetadata).toBeUndefined();
    });

    it('keeps existing customMetadata', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const e = event([fc()]);
      e.customMetadata = {mine: 1};

      await mint(plugin, ctx(), e);

      expect(e.customMetadata['mine']).toBe(1);
      expect(e.customMetadata).toHaveProperty(HMAC_KEY);
    });

    it('uses the reserved internal prefix', () => {
      expect(HMAC_KEY.startsWith(INTERNAL_METADATA_PREFIX)).toBe(true);
    });
  });

  describe('verification', () => {
    it('accepts an untouched session', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      await mint(plugin, context, event([], {text: 'before'}));
      await mint(
        plugin,
        context,
        event([fc('fc-1', CONFIRM, {a: 1, b: null})]),
      );
      await mint(plugin, context, event([], {text: 'after'}));

      await expect(validate(plugin, context)).resolves.toBeUndefined();
    });

    const tampers: Array<[string, (call: FunctionCall) => void]> = [
      ['changed', (call) => (call.args!['amount'] = 10000)],
      ['added', (call) => (call.args!['extra'] = 'x')],
      ['added null', (call) => (call.args!['extra'] = null)],
      ['removed', (call) => delete call.args!['amount']],
      ['renamed', (call) => (call.name = 'tool')],
    ];
    describe.each(BOTH)('allowUnstampedCalls=%s', (allowUnstampedCalls) => {
      it.each(
        tampers.flatMap(([label, tamper]) =>
          [CONFIRM, 'transfer_money'].map(
            (name) => [label, name, tamper] as const,
          ),
        ),
      )('rejects a %s %s call', async (_label, name, tamper) => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        await mint(plugin, context, event([fc('fc-1', name)]));

        tamper(callAt(context));

        await expect(validate(plugin, context)).rejects.toThrow(
          'does not match',
        );
      });
    });

    it.each(['invocationId', 'branch', 'author'] as const)(
      'rejects a call moved to another %s',
      async (field) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const context = ctx();
        await mint(plugin, context, event([fc('fc-1', 'transfer_money')]));

        context.session.events[0][field] = 'other';

        await expect(validate(plugin, context)).rejects.toThrow(
          'does not match',
        );
      },
    );

    it.each(['id', 'appName', 'userId'] as const)(
      'rejects a stamp from a session with another %s',
      async (field) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const context = ctx();
        await mint(plugin, context, event([fc()]));

        context.session[field] = 'other';

        await expect(validate(plugin, context)).rejects.toThrow(
          'does not match',
        );
      },
    );

    it('rejects a stamp without the version prefix', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      const e = await mint(plugin, context, event([fc()]));

      const stamps = stampsOf(e);
      stamps['fc-1'] = stamps['fc-1'].slice(STAMP_PREFIX.length);

      await expect(validate(plugin, context)).rejects.toThrow('does not match');
    });

    it('rejects a stamp written in uppercase hex', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      const e = await mint(plugin, context, event([fc()]));

      const stamps = stampsOf(e);
      stamps['fc-1'] = STAMP_PREFIX + stamps['fc-1'].slice(3).toUpperCase();

      await expect(validate(plugin, context)).rejects.toThrow('does not match');
    });

    describe.each(BOTH)('allowUnstampedCalls=%s', (allowUnstampedCalls) => {
      it.each([
        ['re-keyed', (call: FunctionCall) => (call.id = 'fc-9')],
        ['id removed', (call: FunctionCall) => (call.id = undefined)],
      ])('rejects a stamp whose call was %s', async (_label, tamper) => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        await mint(plugin, context, event([fc()]));

        tamper(callAt(context));

        // By default the moved call may first be rejected as unstamped.
        await expect(validate(plugin, context)).rejects.toThrow(
          /no matching call|no integrity stamp/,
        );
      });

      it.each([
        ['a string', 'abc'],
        ['an array', ['fc-1']],
        ['a number value', {'fc-1': 1}],
        ['a non-ASCII value', {'fc-1': 'v1:\u00e9'}],
      ])('rejects a malformed stamp map: %s', async (_label, stamps) => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        const e = await mint(plugin, context, event([fc()]));

        e.customMetadata![HMAC_KEY] = stamps;

        await expect(validate(plugin, context)).rejects.toThrow('malformed');
      });
    });

    it('accepts reordered events, since stamps are not chained', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      await mint(plugin, context, event([fc('fc-1')]));
      await mint(plugin, context, event([fc('fc-2')]));

      context.session.events.reverse();

      await expect(validate(plugin, context)).resolves.toBeUndefined();
    });

    it('names the modified call in the error', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      await mint(plugin, context, event([fc('fc-1')]));
      await mint(plugin, context, event([fc('fc-2')]));

      callAt(context, 1).args!['amount'] = 1;

      await expect(validate(plugin, context)).rejects.toThrow('fc-2');
    });

    it('throws ToolCallIntegrityError', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      await mint(plugin, context, event([fc()]));

      callAt(context).args!['amount'] = 1;

      await expect(validate(plugin, context)).rejects.toBeInstanceOf(
        ToolCallIntegrityError,
      );
    });
  });

  describe('unstamped calls', () => {
    it.each([CONFIRM, 'transfer_money'])(
      'rejects a never-stamped %s call by default',
      async (name) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const context = ctx();
        context.session.events.push(event([fc('fc-1', name)]));

        await expect(validate(plugin, context)).rejects.toThrow(
          'no integrity stamp',
        );
      },
    );

    it.each(BOTH)(
      'does not check calls without an ID (allowUnstampedCalls=%s)',
      async (allowUnstampedCalls) => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        context.session.events.push(
          event([fc(null), fc(null, 'transfer_money')]),
        );

        await expect(validate(plugin, context)).resolves.toBeUndefined();
      },
    );

    it('rejects a stripped stamp by default', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      const e = await mint(plugin, context, event([fc()]));

      delete e.customMetadata![HMAC_KEY];

      await expect(validate(plugin, context)).rejects.toThrow(
        'no integrity stamp',
      );
    });

    it('warns when allowUnstampedCalls is set', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const plugin = new ToolCallIntegrityPlugin({
        secretKey: KEY,
        allowUnstampedCalls: true,
      });
      const context = ctx();
      context.session.events.push(event([fc()]));

      await validate(plugin, context);

      expect(String(warn.mock.calls[0])).toContain('no integrity stamp');
    });
  });

  describe('key rotation', () => {
    it('verifies old stamps during rotation', async () => {
      const context = ctx();
      await mint(
        new ToolCallIntegrityPlugin({secretKey: bytes('old')}),
        context,
        event([fc()]),
      );

      await expect(
        validate(
          new ToolCallIntegrityPlugin({
            secretKey: [bytes('new'), bytes('old')],
          }),
          context,
        ),
      ).resolves.toBeUndefined();
    });

    it('signs with the first key', async () => {
      const context = ctx();
      await mint(
        new ToolCallIntegrityPlugin({secretKey: [bytes('new'), bytes('old')]}),
        context,
        event([fc()]),
      );

      await expect(
        validate(
          new ToolCallIntegrityPlugin({secretKey: bytes('new')}),
          context,
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects a retired key', async () => {
      const context = ctx();
      await mint(
        new ToolCallIntegrityPlugin({secretKey: bytes('old')}),
        context,
        event([fc()]),
      );

      await expect(
        validate(
          new ToolCallIntegrityPlugin({secretKey: bytes('new')}),
          context,
        ),
      ).rejects.toThrow('does not match');
    });

    it('still rejects modified calls during rotation', async () => {
      const context = ctx();
      await mint(
        new ToolCallIntegrityPlugin({secretKey: bytes('old')}),
        context,
        event([fc()]),
      );

      callAt(context).args!['amount'] = 10000;

      await expect(
        validate(
          new ToolCallIntegrityPlugin({
            secretKey: [bytes('new'), bytes('old')],
          }),
          context,
        ),
      ).rejects.toThrow('does not match');
    });
  });

  describe('duplicate IDs', () => {
    describe.each(BOTH)('allowUnstampedCalls=%s', (allowUnstampedCalls) => {
      it.each([
        ['same', {amount: 10}],
        ['different', {amount: 999}],
      ])(
        'refuses a response repeating a call ID with the %s args',
        async (_label, otherArgs) => {
          const plugin = new ToolCallIntegrityPlugin({
            secretKey: KEY,
            allowUnstampedCalls,
          });
          const e = event([
            fc('fc-1'),
            fc('fc-2'),
            fc('fc-1', CONFIRM, otherArgs),
          ]);

          await expect(
            plugin.onEventCallback({invocationContext: ctx(), event: e}),
          ).rejects.toThrow('repeats function call');
          expect(e.customMetadata).toBeUndefined();
        },
      );

      it('rejects a duplicate call ID in one stored event', async () => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        const e = await mint(plugin, context, event([fc()]));

        e.content!.parts!.push(structuredClone(e.content!.parts![0]));

        await expect(validate(plugin, context)).rejects.toThrow('duplicate');
      });
    });

    it('does not refuse a partial response repeating a call ID', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const e = event([fc('fc-1'), fc('fc-1')]);
      e.partial = true;

      await expect(
        plugin.onEventCallback({invocationContext: ctx(), event: e}),
      ).resolves.toBeUndefined();
    });
  });

  describe('store round trip', () => {
    it.each([
      ['a date', new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 123))],
      ['bytes', new Uint8Array([0, 255, 98])],
      ['NaN', NaN],
      ['undefined in an object', {a: undefined, b: 1}],
      ['a nested mix', {nested: [new Date(Date.UTC(2026, 0, 2)), 'ab']}],
    ])('verifies %s after a JSON round trip', async (_label, value) => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      const e = event([{id: 'fc-1', name: 'tool', args: {v: value}}]);
      await plugin.onEventCallback({invocationContext: context, event: e});

      context.session.events.push(JSON.parse(JSON.stringify(e)) as Event);

      await expect(validate(plugin, context)).resolves.toBeUndefined();
    });

    describe.each(['user', 'agent'])('author %s', (author) => {
      it.each([
        ['a stray stamp', {'fc-9': STAMP_PREFIX + '0'.repeat(64)}],
        ['a malformed stamp', 'malformed'],
      ])('ignores %s on an event without calls', async (_label, stamps) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const context = ctx();
        const e = event([], {author, text: 'hi'});
        e.customMetadata = {[HMAC_KEY]: stamps};
        context.session.events.push(e);

        await expect(validate(plugin, context)).resolves.toBeUndefined();
      });
    });
  });

  describe('restored history', () => {
    describe.each(BOTH)('allowUnstampedCalls=%s', (allowUnstampedCalls) => {
      it.each([
        ['unstamped', () => event([fc()])],
        ['without an ID', () => event([fc(null)])],
        [
          'several without IDs',
          () => event([fc(null), fc(null, 'transfer_money')]),
        ],
        ['with duplicate IDs', () => event([fc(), fc()])],
      ])('accepts a restored event %s', async (_label, make) => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        context.session.events.push(markRestored(make()));

        await expect(validate(plugin, context)).resolves.toBeUndefined();
      });
    });

    it.each([
      ['a wrong stamp', {'fc-1': 'v1:bad'}],
      ['a malformed stamp', 'malformed'],
    ])(
      'does not check a marked event with %s; the gate still refuses its calls',
      async (_label, stamps) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const context = ctx();
        const e = event([fc()]);
        e.customMetadata = {[HMAC_KEY]: stamps};
        context.session.events.push(setRestoredMarker(e));

        await expect(validate(plugin, context)).resolves.toBeUndefined();
      },
    );
  });

  describe('execution gate', () => {
    describe.each(BOTH)('allowUnstampedCalls=%s', (allowUnstampedCalls) => {
      const plugin = () =>
        new ToolCallIntegrityPlugin({secretKey: KEY, allowUnstampedCalls});

      it('runs a verified call', async () => {
        const p = plugin();
        const context = ctx();
        await mint(p, context, event([fc()]));

        await expect(gate(p, context)).resolves.toBeUndefined();
      });

      it.each(BOTH)(
        'rejects a call without an ID (restored=%s)',
        async (restored) => {
          const p = plugin();
          const context = ctx();
          const e = event([fc(null)]);
          context.session.events.push(restored ? markRestored(e) : e);

          await expect(gate(p, context, {callId: null})).rejects.toThrow(
            'no ID',
          );
        },
      );

      it('rejects a call that does not match its stamp', async () => {
        const p = plugin();
        const context = ctx();
        await mint(p, context, event([fc()]));

        callAt(context).args!['amount'] = 10000;

        await expect(gate(p, context)).rejects.toThrow('does not match');
      });

      it('rejects a restored call', async () => {
        const p = plugin();
        const context = ctx();
        context.session.events.push(markRestored(event([fc()])));

        await expect(gate(p, context)).rejects.toThrow('restored');
      });

      it('rejects a stamped call marked restored', async () => {
        const p = plugin();
        const context = ctx();
        const e = await mint(p, context, event([fc()]));

        setRestoredMarker(e);

        await expect(gate(p, context)).rejects.toThrow('restored');
      });

      // A repeated ID cannot borrow the stamp of another copy: every stored
      // copy of the call must verify.
      it('rejects a modified copy of a verified call', async () => {
        const p = plugin();
        const context = ctx();
        await mint(p, context, event([fc()]));
        await mint(p, context, event([fc()]));

        callAt(context, 1).args!['amount'] = 10000;

        await expect(gate(p, context)).rejects.toThrow('does not match');
      });

      it('does not let a restored copy block a verified call', async () => {
        // Providers can reuse IDs, so a restored call can share a new call's ID.
        const p = plugin();
        const context = ctx();
        await mint(p, context, event([fc()]));
        context.session.events.push(
          markRestored(event([fc('fc-1', CONFIRM, {amount: 5})])),
        );

        await expect(gate(p, context)).resolves.toBeUndefined();
        await expect(gate(p, context, {toolArgs: {amount: 5}})).rejects.toThrow(
          'arguments',
        );
      });

      // The executed call must match a verified stored call, whichever copy
      // ADK took its arguments from.
      it.each([
        ['changed args', {amount: 10000}, CONFIRM],
        ['missing args', {}, CONFIRM],
        ['another tool', {amount: 10}, 't'],
      ])('rejects an executed call with %s', async (_label, toolArgs, name) => {
        const p = plugin();
        const context = ctx();
        await mint(p, context, event([fc()]));

        await expect(gate(p, context, {toolArgs, name})).rejects.toThrow(
          'arguments',
        );
      });
    });

    it.each(BOTH)(
      'rejects an unstamped call by default (stored=%s)',
      async (stored) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const context = ctx();
        if (stored) {
          context.session.events.push(event([fc()]));
        }

        await expect(gate(plugin, context)).rejects.toThrow(
          'no integrity stamp',
        );
      },
    );

    it.each(BOTH)(
      'warns and runs an unstamped call when allowed (stored=%s)',
      async (stored) => {
        const warn = vi.spyOn(logger, 'warn');
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls: true,
        });
        const context = ctx();
        if (stored) {
          context.session.events.push(event([fc()]));
        }

        await expect(gate(plugin, context)).resolves.toBeUndefined();
        expect(String(warn.mock.calls[0])).toContain('no integrity stamp');
      },
    );

    it('refuses an unstamped call with other args even when allowed', async () => {
      const plugin = new ToolCallIntegrityPlugin({
        secretKey: KEY,
        allowUnstampedCalls: true,
      });
      const context = ctx();
      context.session.events.push(event([fc()]));

      await expect(
        gate(plugin, context, {toolArgs: {amount: 10000}}),
      ).rejects.toThrow('arguments');
    });

    it('rejects an unstamped copy of a verified call by default', async () => {
      const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
      const context = ctx();
      await mint(plugin, context, event([fc()]));
      context.session.events.push(
        event([fc('fc-1', CONFIRM, {amount: 10000})]),
      );

      await expect(gate(plugin, context)).rejects.toThrow('no integrity stamp');
    });
  });

  describe('prepareRestoredEvent', () => {
    it('returns a marked copy without internal metadata', () => {
      const e = event([fc()]);
      e.customMetadata = {[HMAC_KEY]: {'fc-1': 'v1:x'}, mine: 1};

      const copy = ToolCallIntegrityPlugin.prepareRestoredEvent(e);

      expect(copy).not.toBe(e);
      expect(copy.customMetadata).toEqual({
        mine: 1,
        [RESTORED_EVENT_KEY]: true,
      });
      expect(e.customMetadata).toEqual({
        [HMAC_KEY]: {'fc-1': 'v1:x'},
        mine: 1,
      });
      expect(copy.content).toEqual(e.content);
      expect(copy.content).not.toBe(e.content);
      expect(copy.id).toBe(e.id);
    });

    it.each(['stamped elsewhere', 'unstamped', 'no ID'])(
      'makes a copy (%s) that passes the history check by default',
      async (source) => {
        const plugin = new ToolCallIntegrityPlugin({secretKey: KEY});
        const other = ctx();
        other.session.id = 'other-session';
        const e = event([fc(source === 'no ID' ? null : 'fc-1')]);
        if (source === 'stamped elsewhere') {
          await plugin.onEventCallback({invocationContext: other, event: e});
        }
        const context = ctx();

        context.session.events.push(
          ToolCallIntegrityPlugin.prepareRestoredEvent(e),
        );

        await expect(validate(plugin, context)).resolves.toBeUndefined();
      },
    );

    it.each(BOTH)(
      'never lets a copied call execute (allowUnstampedCalls=%s)',
      async (allowUnstampedCalls) => {
        const plugin = new ToolCallIntegrityPlugin({
          secretKey: KEY,
          allowUnstampedCalls,
        });
        const context = ctx();
        const e = event([fc()]);
        await plugin.onEventCallback({invocationContext: context, event: e});

        context.session.events.push(
          ToolCallIntegrityPlugin.prepareRestoredEvent(e),
        );

        await expect(gate(plugin, context)).rejects.toThrow('restored');
      },
    );
  });
});
