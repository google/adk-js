/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerUseFunction,
  ComputerUseTool,
  Context,
  FeatureName,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ToolConfirmation,
  createSession,
  isComputerUseTool,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SCREENSHOT = new Uint8Array([1, 2, 3]);
const SCREENSHOT_BASE64 = 'AQID';

function makeContext(
  options: {functionCallId?: string; toolConfirmation?: ToolConfirmation} = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'agent', model: 'gemini-flash-latest'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1', ...options});
}

/** Builds a tool whose function records the arguments it was called with. */
function makeTool(
  options: {
    execute?: ComputerUseFunction;
    screenSize?: readonly [number, number];
    virtualScreenSize?: readonly [number, number];
  } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const tool = new ComputerUseTool({
    name: 'click_at',
    description: 'Clicks at a coordinate.',
    screenSize: options.screenSize ?? [1920, 1080],
    virtualScreenSize: options.virtualScreenSize,
    execute:
      options.execute ??
      ((args) => {
        calls.push(args);
        return {screenshot: SCREENSHOT, url: 'https://example.com'};
      }),
  });
  return {tool, calls};
}

describe('ComputerUseTool', () => {
  it('is a FunctionTool recognized by isComputerUseTool', () => {
    const {tool} = makeTool();

    expect(isComputerUseTool(tool)).toBe(true);
    expect(tool).toBeInstanceOf(FunctionTool);
    expect(tool.virtualScreenSize).toEqual([1000, 1000]);
    expect(
      isComputerUseTool(
        new FunctionTool({name: 'f', description: 'f', execute: () => 'ok'}),
      ),
    ).toBe(false);
  });

  describe('constructor', () => {
    it.each([[[0, 1080]], [[1920, -1]], [[Number.NaN, 1080]]] as const)(
      'rejects screenSize %j',
      (screenSize) => {
        expect(() => makeTool({screenSize})).toThrow(
          'screenSize dimensions must be positive',
        );
      },
    );

    it('rejects a non-positive virtualScreenSize', () => {
      expect(() => makeTool({virtualScreenSize: [1000, 0]})).toThrow(
        'virtualScreenSize dimensions must be positive',
      );
    });

    it('cannot be constructed while the feature is disabled', async () => {
      await withTemporaryFeatureOverride(
        FeatureName.COMPUTER_USE,
        false,
        () => {
          expect(() => makeTool()).toThrow(
            'Feature COMPUTER_USE is not enabled.',
          );
        },
      );
    });
  });

  describe('coordinate scaling', () => {
    it.each([
      [
        {x: 500, y: 500},
        {x: 960, y: 540},
      ],
      [
        {x: 0, y: 0},
        {x: 0, y: 0},
      ],
      [
        {x: -10, y: -10},
        {x: 0, y: 0},
      ],
      [
        {x: 1000, y: 1000},
        {x: 1919, y: 1079},
      ],
      [
        {x: 2000, y: 1500},
        {x: 1919, y: 1079},
      ],
      [
        {x: 333.9, y: 1},
        {x: 641, y: 1},
      ],
      [
        {x: '250', y: '750'},
        {x: 480, y: 810},
      ],
    ])('scales %j to %j', async (args, expected) => {
      const {tool, calls} = makeTool();

      await tool.runAsync({args, toolContext: makeContext()});

      expect(calls).toEqual([expected]);
    });

    it('scales destination, start and end coordinates', async () => {
      const {tool, calls} = makeTool();

      await tool.runAsync({
        args: {
          destination_x: 100,
          destination_y: 900,
          start_x: 250,
          start_y: 500,
          end_x: 750,
          end_y: 250,
        },
        toolContext: makeContext(),
      });

      expect(calls).toEqual([
        {
          destination_x: 192,
          destination_y: 972,
          start_x: 480,
          start_y: 540,
          end_x: 1440,
          end_y: 270,
        },
      ]);
    });

    it('scales from a custom virtual screen size', async () => {
      const {tool, calls} = makeTool({
        screenSize: [1280, 720],
        virtualScreenSize: [2000, 2000],
      });

      await tool.runAsync({
        args: {x: 1000, y: 500},
        toolContext: makeContext(),
      });

      expect(calls).toEqual([{x: 640, y: 180}]);
    });

    it('leaves non-coordinate arguments alone', async () => {
      const {tool, calls} = makeTool();

      await tool.runAsync({
        args: {text: 'hello', press_enter: false},
        toolContext: makeContext(),
      });

      expect(calls).toEqual([{text: 'hello', press_enter: false}]);
    });

    it.each(['abc', '1.5', null, [1], Number.POSITIVE_INFINITY])(
      'rejects the coordinate %j',
      async (x) => {
        const {tool, calls} = makeTool();

        await expect(
          tool.runAsync({args: {x, y: 1}, toolContext: makeContext()}),
        ).rejects.toThrow('x coordinate must be numeric');
        expect(calls).toEqual([]);
      },
    );

    it('does not modify the caller arguments', async () => {
      const {tool} = makeTool();
      const args = {x: 500, y: 500};

      await tool.runAsync({args, toolContext: makeContext()});

      expect(args).toEqual({x: 500, y: 500});
    });
  });

  describe('results', () => {
    it('returns a computer state as a base64 PNG image and url', async () => {
      const {tool} = makeTool();

      const result = await tool.runAsync({
        args: {x: 1, y: 1},
        toolContext: makeContext(),
      });

      expect(result).toEqual({
        image: {mimetype: 'image/png', data: SCREENSHOT_BASE64},
        url: 'https://example.com',
      });
    });

    it('rejects a computer state with no screenshot', async () => {
      const {tool} = makeTool({
        execute: () => ({url: 'https://example.com'}),
      });

      await expect(
        tool.runAsync({args: {}, toolContext: makeContext()}),
      ).rejects.toThrow(
        'A computer action returned a state with no screenshot',
      );
    });

    it('passes any other result through unchanged', async () => {
      const {tool} = makeTool({
        execute: () => ({error: 'refused', url: 'https://example.com'}),
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: makeContext(),
      });

      expect(result).toEqual({error: 'refused', url: 'https://example.com'});
    });

    it('reports an error the function throws', async () => {
      const {tool} = makeTool({
        execute: () => {
          throw new Error('browser crashed');
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: makeContext()}),
      ).rejects.toThrow("Error in tool 'click_at': browser crashed");
    });
  });

  describe('safety decisions', () => {
    const requireConfirmation = {
      safety_decision: {
        decision: 'require_confirmation',
        explanation: 'The page asks to accept cookies.',
      },
    };

    it('asks for confirmation before running a risky action', async () => {
      const {tool, calls} = makeTool();
      const toolContext = makeContext();

      const result = await tool.runAsync({
        args: {x: 1, y: 1, ...requireConfirmation},
        toolContext,
      });

      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(calls).toEqual([]);
      expect(toolContext.actions.requestedToolConfirmations['fc-1']?.hint).toBe(
        'The page asks to accept cookies.',
      );
      expect(toolContext.actions.skipSummarization).toBe(true);
    });

    it('uses a default hint when the model gives no explanation', async () => {
      const {tool} = makeTool();
      const toolContext = makeContext();

      await tool.runAsync({
        args: {safety_decision: {decision: 'require_confirmation'}},
        toolContext,
      });

      expect(toolContext.actions.requestedToolConfirmations['fc-1']?.hint).toBe(
        'This computer use action requires safety confirmation.',
      );
    });

    it('runs an action the model judged safe without asking', async () => {
      const {tool, calls} = makeTool();
      const toolContext = makeContext();

      await tool.runAsync({
        args: {x: 500, y: 500, safety_decision: {decision: 'regular'}},
        toolContext,
      });

      expect(calls).toEqual([{x: 960, y: 540}]);
      expect(toolContext.actions.requestedToolConfirmations).toEqual({});
    });

    it('does not run a rejected action', async () => {
      const {tool, calls} = makeTool();

      const result = await tool.runAsync({
        args: {x: 1, y: 1, ...requireConfirmation},
        toolContext: makeContext({
          toolConfirmation: new ToolConfirmation({confirmed: false}),
        }),
      });

      expect(result).toEqual({error: 'This tool call is rejected.'});
      expect(calls).toEqual([]);
    });

    it('runs a confirmed action and acknowledges the decision', async () => {
      const {tool, calls} = makeTool();

      const result = await tool.runAsync({
        args: {x: 500, y: 500, ...requireConfirmation},
        toolContext: makeContext({
          toolConfirmation: new ToolConfirmation({confirmed: true}),
        }),
      });

      expect(calls).toEqual([{x: 960, y: 540}]);
      expect(result).toEqual({
        image: {mimetype: 'image/png', data: SCREENSHOT_BASE64},
        url: 'https://example.com',
        safety_acknowledgement: 'true',
      });
    });

    it('wraps a confirmed non-object result before acknowledging it', async () => {
      const {tool} = makeTool({execute: () => 'done'});

      const result = await tool.runAsync({
        args: requireConfirmation,
        toolContext: makeContext({
          toolConfirmation: new ToolConfirmation({confirmed: true}),
        }),
      });

      expect(result).toEqual({result: 'done', safety_acknowledgement: 'true'});
    });

    it('reports that a risky call requires confirmation', async () => {
      const {tool} = makeTool();

      await expect(
        tool.checkRequireConfirmation(requireConfirmation),
      ).resolves.toBe(true);
      await expect(tool.checkRequireConfirmation({x: 1, y: 1})).resolves.toBe(
        false,
      );
    });
  });

  it('adds nothing to the request', async () => {
    const {tool} = makeTool();
    const llmRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await tool.processLlmRequest({toolContext: makeContext(), llmRequest});

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });
});
