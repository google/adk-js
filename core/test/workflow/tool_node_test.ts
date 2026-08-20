/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getFunctionResponses} from '../../src/events/event.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {BaseTool, RunAsyncToolRequest} from '../../src/tools/base_tool.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
import {createIc, driveNode} from './test_helpers.js';

/** A tool that records the args it was called with and echoes them back. */
class EchoTool extends BaseTool {
  lastArgs?: Record<string, unknown>;
  constructor() {
    super({name: 'echo', description: 'echoes its args'});
  }
  async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    this.lastArgs = args;
    return {echoed: args};
  }
}

/** A tool that writes to its context state and returns a scalar. */
class StateWritingTool extends BaseTool {
  constructor() {
    super({name: 'writer', description: 'writes state'});
  }
  async runAsync({toolContext}: RunAsyncToolRequest): Promise<unknown> {
    toolContext.state.set('touched', true);
    return 'done';
  }
}

describe('ToolNode execution', () => {
  it('invokes the tool with coerced args and surfaces the response', async () => {
    const tool = new EchoTool();
    const {events, output} = await driveNode(new ToolNode(tool), {city: 'ams'});

    expect(tool.lastArgs).toEqual({city: 'ams'});
    expect(output).toEqual({echoed: {city: 'ams'}});
    // The event carries a canonical functionResponse part (visible to history).
    const responses = getFunctionResponses(events.at(-1)!);
    expect(responses[0]?.name).toBe('echo');
  });

  it('propagates tool context state writes onto the emitted event', async () => {
    const {events} = await driveNode(new ToolNode(new StateWritingTool()));
    expect(events.at(-1)?.actions.stateDelta).toEqual({touched: true});
  });

  it('runs the plugin tool-callback chain (before_tool_callback override)', async () => {
    const tool = new EchoTool();
    class OverridePlugin extends BasePlugin {
      constructor() {
        super('override');
      }
      override async beforeToolCallback(): Promise<Record<string, unknown>> {
        return {overridden: true};
      }
    }
    const ic = createIc();
    ic.pluginManager.registerPlugin(new OverridePlugin());

    const {output} = await driveNode(new ToolNode(tool), {a: 1}, ic);

    // The plugin short-circuited the call: its response wins and the tool's own
    // runAsync never ran — proof ToolNode goes through the shared execution path.
    expect(output).toEqual({overridden: true});
    expect(tool.lastArgs).toBeUndefined();
  });

  it('throws for a long-running tool at construction', () => {
    class LongTool extends BaseTool {
      constructor() {
        super({name: 'long', description: 'long', isLongRunning: true});
      }
      async runAsync(): Promise<unknown> {
        return null;
      }
    }
    expect(() => new ToolNode(new LongTool())).toThrow(/long-running/i);
  });
});

describe('ToolNode argument coercion', () => {
  const drive = async (input: unknown) => {
    const tool = new EchoTool();
    await driveNode(new ToolNode(tool), input);
    return tool.lastArgs;
  };

  it('passes an object through unchanged', async () => {
    expect(await drive({a: 1})).toEqual({a: 1});
  });

  it('parses a JSON-string input', async () => {
    expect(await drive('{"a":2}')).toEqual({a: 2});
  });

  it('extracts and parses text from genai Content', async () => {
    expect(await drive({role: 'user', parts: [{text: '{"a":3}'}]})).toEqual({
      a: 3,
    });
  });

  it('treats null / empty string as no arguments', async () => {
    expect(await drive(null)).toEqual({});
    expect(await drive('')).toEqual({});
  });

  it('rejects array and scalar inputs', async () => {
    await expect(
      driveNode(new ToolNode(new EchoTool()), [1, 2]),
    ).rejects.toThrow(TypeError);
    await expect(driveNode(new ToolNode(new EchoTool()), 5)).rejects.toThrow(
      TypeError,
    );
  });
});
