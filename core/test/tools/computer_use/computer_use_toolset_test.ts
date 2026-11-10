/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  BaseToolset,
  ComputerEnvironment,
  ComputerState,
  ComputerUseTool,
  ComputerUseToolset,
  ComputerUseToolsetOptions,
  Context,
  FeatureName,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ToolConfirmation,
  createSession,
  isComputerUseToolset,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Environment, Tool} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {adaptComputerUseTool} from '../../../src/tools/computer_use/computer_use_toolset.js';

const {lookupMock} = vi.hoisted(() => ({lookupMock: vi.fn()}));
vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

const SCREENSHOT = new Uint8Array([1, 2, 3]);
const START_URL = 'https://example.com/start';

const LEGACY_TOOLS = [
  'open_web_browser',
  'click_at',
  'hover_at',
  'type_text_at',
  'scroll_document',
  'scroll_at',
  'wait',
  'go_back',
  'go_forward',
  'search',
  'navigate',
  'key_combination',
  'drag_and_drop',
  'current_state',
];
const MODERN_TOOLS = [
  'click',
  'move',
  'type',
  'scroll',
  'take_screenshot',
  'press_key',
  'hotkey',
];
const OPTIONAL_ACTIONS = [
  'double_click',
  'triple_click',
  'middle_click',
  'right_click',
  'mouse_down',
  'mouse_up',
  'key_down',
  'key_up',
];

/** A computer that records every call it receives. */
class FakeComputer extends BaseComputer {
  readonly calls: unknown[][] = [];
  readonly prepared: Context[] = [];
  initializeCount = 0;
  closeCount = 0;
  url = START_URL;
  environmentValue = ComputerEnvironment.ENVIRONMENT_BROWSER;

  override async initialize(): Promise<void> {
    await Promise.resolve();
    this.initializeCount++;
  }
  override async close(): Promise<void> {
    this.closeCount++;
  }
  override async prepare(toolContext: Context): Promise<void> {
    this.prepared.push(toolContext);
  }
  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }
  async environment(): Promise<ComputerEnvironment> {
    return this.environmentValue;
  }
  openWebBrowser(): Promise<ComputerState> {
    return this.record('openWebBrowser');
  }
  clickAt(x: number, y: number): Promise<ComputerState> {
    return this.record('clickAt', x, y);
  }
  hoverAt(x: number, y: number): Promise<ComputerState> {
    return this.record('hoverAt', x, y);
  }
  typeTextAt(
    x: number,
    y: number,
    text: string,
    pressEnter?: boolean,
    clearBeforeTyping?: boolean,
  ): Promise<ComputerState> {
    return this.record('typeTextAt', x, y, text, pressEnter, clearBeforeTyping);
  }
  scrollDocument(direction: string): Promise<ComputerState> {
    return this.record('scrollDocument', direction);
  }
  scrollAt(
    x: number,
    y: number,
    direction: string,
    magnitude: number,
  ): Promise<ComputerState> {
    return this.record('scrollAt', x, y, direction, magnitude);
  }
  wait(seconds: number): Promise<ComputerState> {
    return this.record('wait', seconds);
  }
  goBack(): Promise<ComputerState> {
    return this.record('goBack');
  }
  goForward(): Promise<ComputerState> {
    return this.record('goForward');
  }
  search(): Promise<ComputerState> {
    return this.record('search');
  }
  navigate(url: string): Promise<ComputerState> {
    this.url = url;
    return this.record('navigate', url);
  }
  keyCombination(keys: string[]): Promise<ComputerState> {
    return this.record('keyCombination', keys);
  }
  dragAndDrop(
    x: number,
    y: number,
    destinationX: number,
    destinationY: number,
  ): Promise<ComputerState> {
    return this.record('dragAndDrop', x, y, destinationX, destinationY);
  }
  currentState(): Promise<ComputerState> {
    return Promise.resolve({screenshot: SCREENSHOT, url: this.url});
  }

  protected record(name: string, ...args: unknown[]): Promise<ComputerState> {
    this.calls.push([name, ...args]);
    return Promise.resolve({screenshot: SCREENSHOT, url: this.url});
  }
}

/** A computer that also implements two of the optional Gemini 3.x actions. */
class PartialComputer extends FakeComputer {
  doubleClick(x: number, y: number, button?: string): Promise<ComputerState> {
    return this.record('doubleClick', x, y, button);
  }
  keyDown(key: string): Promise<ComputerState> {
    return this.record('keyDown', key);
  }
}

/** A computer with bulk text input. */
class TypingComputer extends FakeComputer {
  override typeText(text: string, pressEnter = false): Promise<ComputerState> {
    return this.record('typeText', text, pressEnter);
  }
}

/** A computer that implements the Gemini 3.x actions itself. */
class NativeModernComputer extends FakeComputer {
  click(x: number, y: number, button = 'left'): Promise<ComputerState> {
    return this.record('click', x, y, button);
  }
  move(x: number, y: number): Promise<ComputerState> {
    return this.record('move', x, y);
  }
  type(text: string, pressEnter = true): Promise<ComputerState> {
    return this.record('type', text, pressEnter);
  }
  scroll(
    x: number,
    y: number,
    direction: string,
    magnitudeInPixels = 100,
  ): Promise<ComputerState> {
    return this.record('scroll', x, y, direction, magnitudeInPixels);
  }
  takeScreenshot(): Promise<ComputerState> {
    return this.record('takeScreenshot');
  }
  pressKey(key: string): Promise<ComputerState> {
    return this.record('pressKey', key);
  }
  hotkey(keys: string[]): Promise<ComputerState> {
    return this.record('hotkey', keys);
  }
}

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

function makeRequest(model?: string): LlmRequest {
  return {
    model,
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    config: {},
  };
}

function makeToolset(
  options: Omit<ComputerUseToolsetOptions, 'computer'> & {
    computer?: FakeComputer;
  } = {},
): {toolset: ComputerUseToolset; computer: FakeComputer} {
  const computer = options.computer ?? new FakeComputer();
  return {toolset: new ComputerUseToolset({...options, computer}), computer};
}

async function toolNames(toolset: ComputerUseToolset): Promise<string[]> {
  return (await toolset.getTools()).map((tool) => tool.name);
}

async function getTool(
  toolset: ComputerUseToolset,
  name: string,
): Promise<ComputerUseTool> {
  const tool = (await toolset.getTools()).find((t) => t.name === name);
  if (!tool) {
    throw new Error(`No ${name} tool in the toolset`);
  }
  return tool;
}

async function run(
  toolset: ComputerUseToolset,
  name: string,
  args: Record<string, unknown>,
  toolContext = makeContext(),
): Promise<unknown> {
  return (await getTool(toolset, name)).runAsync({args, toolContext});
}

function computerUseConfig(llmRequest: LlmRequest) {
  const tools = (llmRequest.config?.tools ?? []) as Tool[];
  return tools.filter((tool) => tool.computerUse).map((t) => t.computerUse);
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
});

describe('ComputerUseToolset', () => {
  it('is a toolset recognized by isComputerUseToolset', () => {
    const {toolset} = makeToolset();

    expect(isComputerUseToolset(toolset)).toBe(true);
    expect(toolset).toBeInstanceOf(BaseToolset);
    expect(isComputerUseToolset(new FakeComputer())).toBe(false);
  });

  it('cannot be constructed while the feature is disabled', async () => {
    const computer = new FakeComputer();

    await withTemporaryFeatureOverride(FeatureName.COMPUTER_USE, false, () => {
      expect(() => new ComputerUseToolset({computer})).toThrow(
        'Feature COMPUTER_USE is not enabled.',
      );
    });
  });

  describe('getTools', () => {
    it('exposes the predefined and Gemini 3.x actions', async () => {
      const {toolset} = makeToolset();

      expect(await toolNames(toolset)).toEqual([
        ...LEGACY_TOOLS,
        ...MODERN_TOOLS,
      ]);
    });

    it('exposes the optional actions the computer implements', async () => {
      const {toolset} = makeToolset({computer: new PartialComputer()});

      const names = await toolNames(toolset);

      expect(names).toContain('double_click');
      expect(names).toContain('key_down');
      expect(names).not.toContain('right_click');
      expect(names).not.toContain('key_up');
    });

    it('initializes the computer once for concurrent first calls', async () => {
      const {toolset, computer} = makeToolset();

      const [first, second] = await Promise.all([
        toolset.getTools(),
        toolset.getTools(),
      ]);

      expect(computer.initializeCount).toBe(1);
      expect(second).toBe(first);
      expect(await toolset.getTools()).toBe(first);
    });

    it('does not initialize the computer before it is needed', () => {
      const {computer} = makeToolset();

      expect(computer.initializeCount).toBe(0);
    });

    it('retries initialization after a failure', async () => {
      const {toolset, computer} = makeToolset();
      const initialize = vi
        .spyOn(computer, 'initialize')
        .mockRejectedValueOnce(new Error('Initialization failed'));

      await expect(toolset.getTools()).rejects.toThrow('Initialization failed');
      await expect(toolset.getTools()).resolves.toHaveLength(
        LEGACY_TOOLS.length + MODERN_TOOLS.length,
      );
      expect(initialize).toHaveBeenCalledTimes(2);
      initialize.mockRestore();
    });

    it('scales coordinates to the computer screen size', async () => {
      const {toolset} = makeToolset();

      const tool = await getTool(toolset, 'click_at');

      expect(tool.screenSize).toEqual([1920, 1080]);
      expect(tool.virtualScreenSize).toEqual([1000, 1000]);
    });
  });

  describe('excludedPredefinedFunctions', () => {
    it.each([
      {
        excluded: ['drag_and_drop', 'key_combination'],
        absent: ['drag_and_drop', 'key_combination', 'press_key', 'hotkey'],
        present: ['click_at', 'click'],
      },
      {
        excluded: ['click_at'],
        absent: ['click_at', 'click'],
        present: ['hover_at'],
      },
      {
        excluded: ['hotkey'],
        absent: ['hotkey'],
        present: ['press_key', 'key_combination'],
      },
      {
        excluded: ['press_key', 'hotkey'],
        absent: ['press_key', 'hotkey', 'key_combination'],
        present: ['click'],
      },
      {
        excluded: ['scroll'],
        absent: ['scroll', 'scroll_at'],
        present: ['scroll_document'],
      },
      {
        excluded: ['type_text'],
        absent: ['type', 'type_text_at'],
        present: ['click'],
      },
      {
        excluded: ['wait'],
        absent: ['wait'],
        present: ['current_state'],
      },
    ])(
      'excluding $excluded hides $absent',
      async ({excluded, absent, present}) => {
        const {toolset} = makeToolset({excludedPredefinedFunctions: excluded});

        const names = await toolNames(toolset);

        for (const name of absent) {
          expect(names).not.toContain(name);
        }
        for (const name of present) {
          expect(names).toContain(name);
        }
      },
    );

    it('hides an excluded optional action the computer implements', async () => {
      const {toolset} = makeToolset({
        computer: new PartialComputer(),
        excludedPredefinedFunctions: ['double_click'],
      });

      const names = await toolNames(toolset);

      expect(names).not.toContain('double_click');
      expect(names).toContain('key_down');
    });
  });

  describe('processLlmRequest', () => {
    it('registers the tools and adds the computer use configuration', async () => {
      const {toolset} = makeToolset();
      const llmRequest = makeRequest('gemini-2.5-flash');

      await toolset.processLlmRequest(makeContext(), llmRequest);

      expect(Object.keys(llmRequest.toolsDict)).toEqual([
        ...LEGACY_TOOLS,
        ...MODERN_TOOLS,
      ]);
      expect(computerUseConfig(llmRequest)).toEqual([
        {environment: Environment.ENVIRONMENT_BROWSER},
      ]);
    });

    it('creates the request config when it is missing', async () => {
      const {toolset} = makeToolset();
      const llmRequest: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };

      await toolset.processLlmRequest(makeContext(), llmRequest);

      expect(computerUseConfig(llmRequest)).toHaveLength(1);
    });

    it('maps an unspecified environment', async () => {
      const {toolset, computer} = makeToolset();
      computer.environmentValue = ComputerEnvironment.ENVIRONMENT_UNSPECIFIED;
      const llmRequest = makeRequest('gemini-2.5-flash');

      await toolset.processLlmRequest(makeContext(), llmRequest);

      expect(computerUseConfig(llmRequest)).toEqual([
        {environment: Environment.ENVIRONMENT_UNSPECIFIED},
      ]);
    });

    it('does not add a second computer use configuration', async () => {
      const {toolset} = makeToolset();
      const llmRequest = makeRequest('gemini-2.5-flash');
      llmRequest.config = {
        tools: [{computerUse: {environment: Environment.ENVIRONMENT_BROWSER}}],
      };

      await toolset.processLlmRequest(makeContext(), llmRequest);

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(Object.keys(llmRequest.toolsDict)).toContain('click_at');
    });

    it.each([
      {
        model: 'gemini-2.5-flash',
        excluded: ['drag_and_drop', 'key_combination'],
        expected: ['drag_and_drop', 'key_combination'],
      },
      {
        model: 'gemini-2.5-flash',
        excluded: ['press_key', 'hotkey'],
        expected: ['key_combination'],
      },
      {
        model: 'gemini-2.5-flash',
        excluded: ['hotkey', 'click', 'type_text', 'scroll', 'search'],
        expected: ['click_at', 'type_text_at', 'scroll_at', 'search'],
      },
      {
        model: 'gemini-3-pro-preview',
        excluded: ['click_at', 'key_combination'],
        expected: ['click', 'press_key', 'hotkey', ...OPTIONAL_ACTIONS],
      },
      {
        model: 'gemini-3-pro-preview',
        excluded: undefined,
        expected: OPTIONAL_ACTIONS,
      },
      {
        model: 'gemini-flash-latest',
        excluded: ['click_at', 'key_combination', 'scroll_document'],
        expected: ['click', 'press_key', 'hotkey'],
      },
      {
        model: 'projects/123/locations/us-central1/endpoints/456',
        excluded: ['click_at'],
        expected: ['click'],
      },
      {
        model: undefined,
        excluded: ['current_state', 'wait_5_seconds'],
        expected: ['take_screenshot', 'wait'],
      },
    ])(
      'translates $excluded for $model to $expected',
      async ({model, excluded, expected}) => {
        const {toolset} = makeToolset({excludedPredefinedFunctions: excluded});
        const llmRequest = makeRequest(model);

        await toolset.processLlmRequest(makeContext(), llmRequest);

        expect(
          computerUseConfig(llmRequest)[0]?.excludedPredefinedFunctions,
        ).toEqual(expected);
      },
    );

    it.each(['gemini-2.5-flash', 'gemini-flash-latest', undefined])(
      'excludes nothing for %s when nothing is configured',
      async (model) => {
        const {toolset} = makeToolset();
        const llmRequest = makeRequest(model);

        await toolset.processLlmRequest(makeContext(), llmRequest);

        expect(computerUseConfig(llmRequest)[0]).not.toHaveProperty(
          'excludedPredefinedFunctions',
        );
      },
    );

    it('excludes only the optional actions the computer lacks on Gemini 3', async () => {
      const {toolset} = makeToolset({computer: new PartialComputer()});
      const llmRequest = makeRequest('gemini-3-pro-preview');

      await toolset.processLlmRequest(makeContext(), llmRequest);

      expect(
        computerUseConfig(llmRequest)[0]?.excludedPredefinedFunctions,
      ).toEqual([
        'triple_click',
        'middle_click',
        'right_click',
        'mouse_down',
        'mouse_up',
        'key_up',
      ]);
    });
  });

  describe('actions', () => {
    it('prepares the computer with the tool context before each action', async () => {
      const {toolset, computer} = makeToolset();
      const toolContext = makeContext();

      await run(toolset, 'go_back', {}, toolContext);

      expect(computer.prepared).toEqual([toolContext]);
      expect(computer.calls).toEqual([['goBack']]);
    });

    it.each([
      ['open_web_browser', {}, ['openWebBrowser']],
      ['click_at', {x: 500, y: 500}, ['clickAt', 960, 540]],
      ['hover_at', {x: 250, y: 750}, ['hoverAt', 480, 810]],
      [
        'type_text_at',
        {x: 500, y: 500, text: 'cats'},
        ['typeTextAt', 960, 540, 'cats', true, true],
      ],
      [
        'type_text_at',
        {
          x: 0,
          y: 0,
          text: 'dogs',
          press_enter: false,
          clear_before_typing: false,
        },
        ['typeTextAt', 0, 0, 'dogs', false, false],
      ],
      ['scroll_document', {direction: 'down'}, ['scrollDocument', 'down']],
      [
        'scroll_at',
        {x: 500, y: 500, direction: 'up', magnitude: 400},
        ['scrollAt', 960, 540, 'up', 400],
      ],
      ['wait', {seconds: 0.4}, ['wait', 1]],
      ['wait', {}, ['wait', 1]],
      ['wait', {seconds: -2}, ['wait', 0]],
      ['go_forward', {}, ['goForward']],
      ['search', {}, ['search']],
      [
        'key_combination',
        {keys: ['Control', 'c']},
        ['keyCombination', ['Control', 'c']],
      ],
      [
        'drag_and_drop',
        {x: 100, y: 100, destination_x: 500, destination_y: 500},
        ['dragAndDrop', 192, 108, 960, 540],
      ],
      [
        'drag_and_drop',
        {start_x: 100, start_y: 100, end_x: 500, end_y: 500},
        ['dragAndDrop', 192, 108, 960, 540],
      ],
      ['click', {x: 200, y: 300, intent: 'open search'}, ['clickAt', 384, 324]],
      ['move', {x: 500, y: 500}, ['hoverAt', 960, 540]],
      [
        'scroll',
        {x: 500, y: 500, direction: 'down', magnitude_in_pixels: 450},
        ['scrollAt', 960, 540, 'down', 450],
      ],
      ['scroll', {x: 500, y: 500}, ['scrollAt', 960, 540, 'down', 300]],
      ['press_key', {key: 'Enter'}, ['keyCombination', ['Enter']]],
      [
        'hotkey',
        {keys: ['Control', 'v']},
        ['keyCombination', ['Control', 'v']],
      ],
    ])('%s %j calls %j', async (name, args, expected) => {
      const {toolset, computer} = makeToolset();

      await run(toolset, name, args);

      expect(computer.calls).toEqual([expected]);
    });

    it('returns the screenshot and url of the resulting state', async () => {
      const {toolset} = makeToolset();

      const result = await run(toolset, 'current_state', {});

      expect(result).toEqual({
        image: {mimetype: 'image/png', data: 'AQID'},
        url: START_URL,
      });
    });

    it('types with key presses when the computer has no bulk input', async () => {
      const {toolset, computer} = makeToolset();

      await run(toolset, 'type', {text: 'cat', press_enter: true});

      expect(computer.calls).toEqual([
        ['keyCombination', ['c']],
        ['keyCombination', ['a']],
        ['keyCombination', ['t']],
        ['keyCombination', ['Enter']],
      ]);
    });

    it('types with the computer bulk input when it has one', async () => {
      const {toolset, computer} = makeToolset({computer: new TypingComputer()});

      await run(toolset, 'type', {text: 'hello world'});

      expect(computer.calls).toEqual([['typeText', 'hello world', false]]);
    });

    it('runs the optional actions the computer implements', async () => {
      const {toolset, computer} = makeToolset({
        computer: new PartialComputer(),
      });

      await run(toolset, 'double_click', {x: 500, y: 500});
      await run(toolset, 'double_click', {x: 0, y: 0, button: 'left'});
      await run(toolset, 'key_down', {key: 'Shift'});

      expect(computer.calls).toEqual([
        ['doubleClick', 960, 540, undefined],
        ['doubleClick', 0, 0, 'left'],
        ['keyDown', 'Shift'],
      ]);
    });

    it.each([
      [
        'click',
        {x: 500, y: 500, button: 'right'},
        ['click', 960, 540, 'right'],
      ],
      ['click', {x: 0, y: 0}, ['click', 0, 0, 'left']],
      ['move', {x: 500, y: 500}, ['move', 960, 540]],
      ['type', {text: 'hi'}, ['type', 'hi', true]],
      ['type', {text: 'hi', press_enter: false}, ['type', 'hi', false]],
      [
        'scroll',
        {x: 500, y: 500, direction: 'up', magnitude_in_pixels: 40},
        ['scroll', 960, 540, 'up', 40],
      ],
      [
        'scroll',
        {x: 500, y: 500, direction: 'left'},
        ['scroll', 960, 540, 'left', 100],
      ],
      ['take_screenshot', {}, ['takeScreenshot']],
      ['press_key', {key: 'Enter'}, ['pressKey', 'Enter']],
      ['hotkey', {keys: ['Control', 'v']}, ['hotkey', ['Control', 'v']]],
    ])(
      '%s %j calls the computer own method as %j',
      async (name, args, expected) => {
        const {toolset, computer} = makeToolset({
          computer: new NativeModernComputer(),
        });

        await run(toolset, name, args);

        expect(computer.calls).toEqual([expected]);
      },
    );

    it('declares the arguments of the computer own Gemini 3.x methods', async () => {
      const {toolset} = makeToolset({computer: new NativeModernComputer()});

      const click = (await getTool(toolset, 'click'))._getDeclaration();
      const scroll = (await getTool(toolset, 'scroll'))._getDeclaration();

      expect(click?.parameters?.properties).toHaveProperty('button');
      expect(click?.parameters?.required).toEqual(['x', 'y']);
      expect(scroll?.parameters?.required).toEqual(['x', 'y', 'direction']);
    });

    it('rejects a missing direction for the computer own scroll', async () => {
      const {toolset, computer} = makeToolset({
        computer: new NativeModernComputer(),
      });

      await expect(run(toolset, 'scroll', {x: 1, y: 1})).rejects.toThrow(
        "Missing required argument 'direction'.",
      );
      expect(computer.calls).toEqual([]);
    });

    it.each([
      ['click_at', {x: 1}, "Missing required argument 'y'."],
      [
        'type_text_at',
        {x: 1, y: 1, text: 5},
        "Argument 'text' must be a string",
      ],
      [
        'scroll_document',
        {direction: 'sideways'},
        "Argument 'direction' must be",
      ],
      ['hotkey', {keys: 'Control+c'}, "Argument 'keys' must be a list"],
      [
        'type',
        {text: 'a', press_enter: 'yes'},
        "Argument 'press_enter' must be",
      ],
    ])('%s rejects the arguments %j', async (name, args, message) => {
      const {toolset, computer} = makeToolset();

      await expect(run(toolset, name, args)).rejects.toThrow(message);
      expect(computer.calls).toEqual([]);
    });

    it('runs actions on one computer one at a time', async () => {
      const {toolset, computer} = makeToolset();
      let releaseFirst: () => void = () => {};
      const firstStarted = new Promise<void>((resolve) => {
        vi.spyOn(computer, 'goBack').mockImplementationOnce(async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
          computer.calls.push(['goBack']);
          return {screenshot: SCREENSHOT, url: START_URL};
        });
      });

      const first = run(toolset, 'go_back', {});
      await firstStarted;
      const second = run(toolset, 'go_forward', {});
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(computer.calls).toEqual([]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(computer.calls).toEqual([['goBack'], ['goForward']]);
    });

    it('keeps running actions after one fails', async () => {
      const {toolset, computer} = makeToolset();
      vi.spyOn(computer, 'goBack').mockRejectedValueOnce(new Error('no page'));

      await expect(run(toolset, 'go_back', {})).rejects.toThrow('no page');
      await run(toolset, 'go_forward', {});

      expect(computer.calls).toEqual([['goForward']]);
    });

    it('asks for confirmation before a risky action', async () => {
      const {toolset, computer} = makeToolset();
      const toolContext = makeContext();

      const result = await run(
        toolset,
        'click',
        {
          x: 1,
          y: 1,
          safety_decision: {
            decision: 'require_confirmation',
            explanation: 'Accept the terms?',
          },
        },
        toolContext,
      );

      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(computer.calls).toEqual([]);
      expect(toolContext.actions.requestedToolConfirmations['fc-1']?.hint).toBe(
        'Accept the terms?',
      );
    });
  });

  describe('navigate', () => {
    it.each([
      'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
      'http://169.254.169.254\\@example.com/',
      'https://example.com\\@example.org/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://metadata.goog/',
      'http://printer.local/',
      'http://db.internal/',
      'http://127.0.0.1:8000/',
      'http://[::1]/',
      'http://10.0.0.5/',
      'not a url',
    ])('refuses %s without resolving it', async (url) => {
      const {toolset, computer} = makeToolset();

      const result = await run(toolset, 'navigate', {url});

      expect(computer.calls).toEqual([]);
      expect(result).toEqual({
        error:
          'navigate refused: url must be http(s) and must not target a ' +
          'private or link-local address.',
        url: START_URL,
      });
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('refuses a hostname that resolves to a private address', async () => {
      lookupMock.mockResolvedValue([
        {address: '93.184.216.34', family: 4},
        {address: '10.1.2.3', family: 4},
      ]);
      const {toolset, computer} = makeToolset();

      const result = await run(toolset, 'navigate', {
        url: 'https://rebind.example.com/',
      });

      expect(computer.calls).toEqual([]);
      expect(result).toMatchObject({url: START_URL});
      expect(lookupMock).toHaveBeenCalledWith('rebind.example.com', {
        all: true,
      });
    });

    it('refuses a hostname that does not resolve', async () => {
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
      const {toolset, computer} = makeToolset();

      await run(toolset, 'navigate', {url: 'https://nowhere.example.com/'});

      expect(computer.calls).toEqual([]);
    });

    it('navigates to a public url exactly as given', async () => {
      const {toolset, computer} = makeToolset();
      const toolContext = makeContext();

      const result = await run(
        toolset,
        'navigate',
        {url: 'https://example.com/search?q=adk'},
        toolContext,
      );

      expect(computer.calls).toEqual([
        ['navigate', 'https://example.com/search?q=adk'],
      ]);
      expect(computer.prepared).toEqual([toolContext]);
      expect(result).toMatchObject({url: 'https://example.com/search?q=adk'});
      expect(lookupMock).toHaveBeenCalledTimes(1);
    });

    it('allows private hosts with allowPrivateNetworkAccess', async () => {
      const {toolset, computer} = makeToolset({
        allowPrivateNetworkAccess: true,
      });

      await run(toolset, 'navigate', {url: 'http://127.0.0.1:8000/'});

      expect(computer.calls).toEqual([['navigate', 'http://127.0.0.1:8000/']]);
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('still refuses a non-http or backslash url with allowPrivateNetworkAccess', async () => {
      const {toolset, computer} = makeToolset({
        allowPrivateNetworkAccess: true,
      });

      await run(toolset, 'navigate', {url: 'file:///etc/passwd'});
      await run(toolset, 'navigate', {url: 'http://127.0.0.1\\@example.com/'});

      expect(computer.calls).toEqual([]);
    });
  });

  describe('close', () => {
    it('closes the computer and initializes it again on next use', async () => {
      const {toolset, computer} = makeToolset();
      const tools = await toolset.getTools();

      await toolset.close();
      await toolset.close();

      expect(computer.closeCount).toBe(1);
      const reloaded = await toolset.getTools();
      expect(reloaded).not.toBe(tools);
      expect(computer.initializeCount).toBe(2);

      await toolset.close();
      expect(computer.closeCount).toBe(2);
    });
  });
});

describe('adaptComputerUseTool', () => {
  async function requestWithTools(): Promise<LlmRequest> {
    const {toolset} = makeToolset();
    const llmRequest = makeRequest('gemini-2.5-flash');
    await toolset.processLlmRequest(makeContext(), llmRequest);
    return llmRequest;
  }

  it('replaces a tool with an adapted one under a new name', async () => {
    const llmRequest = await requestWithTools();
    const original = llmRequest.toolsDict['wait'] as ComputerUseTool;

    await adaptComputerUseTool({
      methodName: 'wait',
      adapter: (func) => ({
        name: 'wait_5_seconds',
        description: 'Waits for 5 seconds.',
        execute: (_args, toolContext) => func({seconds: 5}, toolContext),
      }),
      llmRequest,
    });

    expect(llmRequest.toolsDict['wait']).toBeUndefined();
    const adapted = llmRequest.toolsDict['wait_5_seconds'] as ComputerUseTool;
    expect(adapted).toBeInstanceOf(ComputerUseTool);
    expect(adapted.screenSize).toEqual(original.screenSize);
    expect(adapted.virtualScreenSize).toEqual(original.virtualScreenSize);
  });

  it('accepts an async adapter that keeps the name', async () => {
    const llmRequest = await requestWithTools();
    const original = llmRequest.toolsDict['wait'];

    await adaptComputerUseTool({
      methodName: 'wait',
      adapter: async (func) => ({
        name: 'wait',
        description: 'Waits for 3 seconds.',
        execute: (_args, toolContext) => func({seconds: 3}, toolContext),
      }),
      llmRequest,
    });

    expect(llmRequest.toolsDict['wait']).toBeInstanceOf(ComputerUseTool);
    expect(llmRequest.toolsDict['wait']).not.toBe(original);
  });

  it.each(['screen_size', 'type_text', 'not_a_method'])(
    'leaves the request alone for %s',
    async (methodName) => {
      const llmRequest = await requestWithTools();
      const before = {...llmRequest.toolsDict};
      const adapter = vi.fn();

      await adaptComputerUseTool({methodName, adapter, llmRequest});

      expect(adapter).not.toHaveBeenCalled();
      expect(llmRequest.toolsDict).toEqual(before);
    },
  );

  it('leaves the request alone when the tool is not registered', async () => {
    const llmRequest = makeRequest('gemini-2.5-flash');
    const adapter = vi.fn();

    await adaptComputerUseTool({methodName: 'wait', adapter, llmRequest});

    expect(adapter).not.toHaveBeenCalled();
    expect(llmRequest.toolsDict).toEqual({});
  });
});
