/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';

import {isBrowser} from '../../utils/env_aware_utils.js';
import {logger} from '../../utils/logger.js';
import {
  isHttpUrl,
  isIpAddress,
  isNonGlobalAddress,
  normalizeHost,
  resolveHostAddresses,
} from '../../utils/ssrf_guard.js';
import {BaseComputer, ComputerState, ScrollDirection} from './base_computer.js';

/**
 * A computer use action the model can call, before it is wrapped in a
 * `ComputerUseTool`.
 */
export interface ComputerAction {
  /** The predefined function name the model calls, such as `click_at`. */
  readonly name: string;
  /** The description of the action. */
  readonly description: string;
  /** The schema of the action's arguments. */
  readonly parameters: Schema;
  /** Runs the action on the computer with the model's arguments. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** The options for {@link createComputerActions}. */
export interface ComputerActionsOptions {
  /** The computer the actions run on. */
  computer: BaseComputer;
  /** Whether `navigate` may target private and loopback hosts. */
  allowPrivateNetworkAccess: boolean;
}

/**
 * The predefined actions that map one-to-one onto {@link BaseComputer}
 * methods, in the order the toolset exposes them.
 */
export const LEGACY_ACTION_NAMES: readonly string[] = [
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

/** Gemini 3.x mouse actions that are exposed only when the computer has them. */
export const OPTIONAL_MOUSE_ACTIONS = [
  'double_click',
  'triple_click',
  'middle_click',
  'right_click',
  'mouse_down',
  'mouse_up',
] as const;

/** Gemini 3.x key actions that are exposed only when the computer has them. */
export const OPTIONAL_KEY_ACTIONS = ['key_down', 'key_up'] as const;

type OptionalMouseAction = (typeof OPTIONAL_MOUSE_ACTIONS)[number];
type OptionalKeyAction = (typeof OPTIONAL_KEY_ACTIONS)[number];

/** The {@link BaseComputer} method behind each optional mouse action. */
const MOUSE_METHODS: Record<
  OptionalMouseAction,
  | 'doubleClick'
  | 'tripleClick'
  | 'middleClick'
  | 'rightClick'
  | 'mouseDown'
  | 'mouseUp'
> = {
  double_click: 'doubleClick',
  triple_click: 'tripleClick',
  middle_click: 'middleClick',
  right_click: 'rightClick',
  mouse_down: 'mouseDown',
  mouse_up: 'mouseUp',
};

/** The {@link BaseComputer} method behind each optional key action. */
const KEY_METHODS: Record<OptionalKeyAction, 'keyDown' | 'keyUp'> = {
  key_down: 'keyDown',
  key_up: 'keyUp',
};

const SCROLL_DIRECTIONS: readonly ScrollDirection[] = [
  'up',
  'down',
  'left',
  'right',
];

/** Hostnames that always designate the local machine or a metadata endpoint. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.goog']);

/** Hostname suffixes reserved for loopback, link-local and internal networks. */
const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.metadata.goog',
];

/** The authority of an absolute URL, as written. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

const URL_REFUSED_ERROR =
  'navigate refused: url must be http(s) and must not target a private or ' +
  'link-local address.';

const INTEGER: Schema = {type: Type.INTEGER};
const NUMBER: Schema = {type: Type.NUMBER};
const STRING: Schema = {type: Type.STRING};
const BOOLEAN: Schema = {type: Type.BOOLEAN};
const STRING_ARRAY: Schema = {type: Type.ARRAY, items: {type: Type.STRING}};
const DIRECTION: Schema = {type: Type.STRING, enum: [...SCROLL_DIRECTIONS]};

/**
 * Returns the optional Gemini 3.x actions that `computer` does not implement.
 *
 * @param computer The computer to probe.
 * @returns The action names, in their canonical order.
 */
export function unimplementedOptionalActions(computer: BaseComputer): string[] {
  return [
    ...OPTIONAL_MOUSE_ACTIONS.filter(
      (name) => typeof computer[MOUSE_METHODS[name]] !== 'function',
    ),
    ...OPTIONAL_KEY_ACTIONS.filter(
      (name) => typeof computer[KEY_METHODS[name]] !== 'function',
    ),
  ];
}

/**
 * Builds every action the computer supports: the predefined actions, the
 * Gemini 3.x actions that translate onto them, and the optional Gemini 3.x
 * actions the computer implements.
 *
 * @param options The computer and its configuration.
 * @returns The actions, legacy ones first.
 */
export function createComputerActions(
  options: ComputerActionsOptions,
): ComputerAction[] {
  return [
    ...createLegacyActions(options),
    ...createModernActions(options.computer),
    ...createOptionalActions(options.computer),
  ];
}

function createLegacyActions({
  computer,
  allowPrivateNetworkAccess,
}: ComputerActionsOptions): ComputerAction[] {
  return [
    {
      name: 'open_web_browser',
      description: 'Opens the web browser.',
      parameters: objectSchema({}),
      execute: () => computer.openWebBrowser(),
    },
    {
      name: 'click_at',
      description: 'Clicks at a specific x, y coordinate on the webpage.',
      parameters: objectSchema({x: INTEGER, y: INTEGER}),
      execute: (args) =>
        computer.clickAt(readNumber(args, 'x'), readNumber(args, 'y')),
    },
    {
      name: 'hover_at',
      description:
        'Hovers at a specific x, y coordinate on the webpage. May be used to ' +
        'explore sub-menus that appear on hover.',
      parameters: objectSchema({x: INTEGER, y: INTEGER}),
      execute: (args) =>
        computer.hoverAt(readNumber(args, 'x'), readNumber(args, 'y')),
    },
    {
      name: 'type_text_at',
      description:
        'Types text at a specific x, y coordinate. Presses ENTER after ' +
        'typing unless press_enter is false, and clears existing content ' +
        'before typing unless clear_before_typing is false.',
      parameters: objectSchema(
        {
          x: INTEGER,
          y: INTEGER,
          text: STRING,
          press_enter: BOOLEAN,
          clear_before_typing: BOOLEAN,
        },
        ['x', 'y', 'text'],
      ),
      execute: (args) =>
        computer.typeTextAt(
          readNumber(args, 'x'),
          readNumber(args, 'y'),
          readString(args, 'text'),
          readBoolean(args, 'press_enter', true),
          readBoolean(args, 'clear_before_typing', true),
        ),
    },
    {
      name: 'scroll_document',
      description:
        'Scrolls the entire webpage "up", "down", "left" or "right" based on ' +
        'direction.',
      parameters: objectSchema({direction: DIRECTION}),
      execute: (args) => computer.scrollDocument(readDirection(args)),
    },
    {
      name: 'scroll_at',
      description:
        'Scrolls up, down, right, or left at an x, y coordinate by magnitude.',
      parameters: objectSchema({
        x: INTEGER,
        y: INTEGER,
        direction: DIRECTION,
        magnitude: INTEGER,
      }),
      execute: (args) =>
        computer.scrollAt(
          readNumber(args, 'x'),
          readNumber(args, 'y'),
          readDirection(args),
          readNumber(args, 'magnitude'),
        ),
    },
    {
      name: 'wait',
      description: 'Waits for the specified number of seconds.',
      parameters: objectSchema({seconds: NUMBER}, []),
      execute: (args) =>
        computer.wait(Math.max(0, Math.ceil(readNumber(args, 'seconds', 1)))),
    },
    {
      name: 'go_back',
      description:
        'Navigates back to the previous webpage in the browser history.',
      parameters: objectSchema({}),
      execute: () => computer.goBack(),
    },
    {
      name: 'go_forward',
      description:
        'Navigates forward to the next webpage in the browser history.',
      parameters: objectSchema({}),
      execute: () => computer.goForward(),
    },
    {
      name: 'search',
      description:
        'Directly jumps to a search engine home page. Used when you need to ' +
        'start with a search.',
      parameters: objectSchema({}),
      execute: () => computer.search(),
    },
    {
      name: 'navigate',
      description: 'Navigates directly to a specified URL.',
      parameters: objectSchema({url: STRING}),
      execute: (args) =>
        navigate({computer, url: args['url'], allowPrivateNetworkAccess}),
    },
    {
      name: 'key_combination',
      description:
        'Presses keyboard keys and combinations, such as "control+c" or ' +
        '"enter".',
      parameters: objectSchema({keys: STRING_ARRAY}),
      execute: (args) => computer.keyCombination(readStringArray(args, 'keys')),
    },
    {
      name: 'drag_and_drop',
      description:
        'Drags an element from an x, y coordinate and drops it at a ' +
        'destination_x, destination_y coordinate.',
      parameters: objectSchema({
        x: INTEGER,
        y: INTEGER,
        destination_x: INTEGER,
        destination_y: INTEGER,
      }),
      execute: (args) =>
        computer.dragAndDrop(
          readNumber(args, 'x', args['start_x']),
          readNumber(args, 'y', args['start_y']),
          readNumber(args, 'destination_x', args['end_x']),
          readNumber(args, 'destination_y', args['end_y']),
        ),
    },
    {
      name: 'current_state',
      description: 'Returns the current state of the current webpage.',
      parameters: objectSchema({}),
      execute: () => computer.currentState(),
    },
  ];
}

/**
 * Builds the Gemini 3.x actions. Each one calls the computer's own method of
 * the same name when it has one, and otherwise translates onto the predefined
 * methods.
 */
function createModernActions(computer: BaseComputer): ComputerAction[] {
  const click = computer.click?.bind(computer);
  const move = computer.move?.bind(computer);
  const type = computer.type?.bind(computer);
  const scroll = computer.scroll?.bind(computer);
  const takeScreenshot = computer.takeScreenshot?.bind(computer);
  const pressKey = computer.pressKey?.bind(computer);
  const hotkey = computer.hotkey?.bind(computer);
  return [
    {
      name: 'click',
      description: 'Clicks at the specified (x, y) coordinates.',
      parameters: click
        ? objectSchema({x: INTEGER, y: INTEGER, button: STRING}, ['x', 'y'])
        : objectSchema({x: INTEGER, y: INTEGER}),
      execute: (args) => {
        const x = readNumber(args, 'x');
        const y = readNumber(args, 'y');
        return click
          ? click(x, y, readOptional(args, 'button', readString))
          : computer.clickAt(x, y);
      },
    },
    {
      name: 'move',
      description: 'Moves the cursor to the specified (x, y) coordinates.',
      parameters: objectSchema({x: INTEGER, y: INTEGER}),
      execute: (args) =>
        (move ?? computer.hoverAt.bind(computer))(
          readNumber(args, 'x'),
          readNumber(args, 'y'),
        ),
    },
    {
      name: 'type',
      description: 'Types text into the currently focused element.',
      parameters: objectSchema({text: STRING, press_enter: BOOLEAN}, ['text']),
      execute: (args) => {
        const text = readString(args, 'text');
        return type
          ? type(
              text,
              readOptional(args, 'press_enter', (a, n) =>
                readBoolean(a, n, false),
              ),
            )
          : computer.typeText(text, readBoolean(args, 'press_enter', false));
      },
    },
    {
      name: 'scroll',
      description: 'Scrolls the webpage at the specified coordinates.',
      parameters: objectSchema(
        {
          x: INTEGER,
          y: INTEGER,
          direction: DIRECTION,
          magnitude_in_pixels: INTEGER,
        },
        scroll ? ['x', 'y', 'direction'] : ['x', 'y'],
      ),
      execute: (args) => {
        const x = readNumber(args, 'x');
        const y = readNumber(args, 'y');
        return scroll
          ? scroll(
              x,
              y,
              readDirection(args),
              readOptional(args, 'magnitude_in_pixels', readNumber),
            )
          : computer.scrollAt(
              x,
              y,
              readDirection(args, 'down'),
              readNumber(args, 'magnitude_in_pixels', 300),
            );
      },
    },
    {
      name: 'take_screenshot',
      description: 'Takes a screenshot of the current webpage state.',
      parameters: objectSchema({}),
      execute: () =>
        takeScreenshot ? takeScreenshot() : computer.currentState(),
    },
    {
      name: 'press_key',
      description: 'Presses a single keyboard key.',
      parameters: objectSchema({key: STRING}),
      execute: (args) => {
        const key = readString(args, 'key');
        return pressKey ? pressKey(key) : computer.keyCombination([key]);
      },
    },
    {
      name: 'hotkey',
      description: 'Presses a combination of keyboard keys simultaneously.',
      parameters: objectSchema({keys: STRING_ARRAY}),
      execute: (args) =>
        (hotkey ?? computer.keyCombination.bind(computer))(
          readStringArray(args, 'keys'),
        ),
    },
  ];
}

function createOptionalActions(computer: BaseComputer): ComputerAction[] {
  const actions: ComputerAction[] = [];
  for (const name of OPTIONAL_MOUSE_ACTIONS) {
    const method = computer[MOUSE_METHODS[name]]?.bind(computer);
    if (!method) {
      continue;
    }
    actions.push({
      name,
      description: `Performs ${name.replace('_', ' ')} at the specified (x, y) coordinates.`,
      parameters: objectSchema({x: INTEGER, y: INTEGER, button: STRING}, [
        'x',
        'y',
      ]),
      execute: (args) => {
        const button = args['button'];
        return button === undefined
          ? method(readNumber(args, 'x'), readNumber(args, 'y'))
          : method(
              readNumber(args, 'x'),
              readNumber(args, 'y'),
              readString(args, 'button'),
            );
      },
    });
  }
  for (const name of OPTIONAL_KEY_ACTIONS) {
    const method = computer[KEY_METHODS[name]]?.bind(computer);
    if (!method) {
      continue;
    }
    actions.push({
      name,
      description:
        name === 'key_down'
          ? 'Presses a keyboard key down and holds it.'
          : 'Releases a keyboard key.',
      parameters: objectSchema({key: STRING}),
      execute: (args) => method(readString(args, 'key')),
    });
  }
  return actions;
}

/**
 * Navigates to `url` after checking it is safe to hand to the browser.
 *
 * A refused url never reaches the computer. The response still carries the
 * url the browser is on, because the computer use model rejects a function
 * response without one.
 */
async function navigate({
  computer,
  url,
  allowPrivateNetworkAccess,
}: {
  computer: BaseComputer;
  url: unknown;
  allowPrivateNetworkAccess: boolean;
}): Promise<ComputerState | {error: string; url?: string}> {
  if (
    typeof url === 'string' &&
    (await isSafeNavigationUrl(url, allowPrivateNetworkAccess))
  ) {
    return computer.navigate(url);
  }
  logger.warn('Refusing navigate(): url failed safety validation.');
  const state = await computer.currentState();
  return {error: URL_REFUSED_ERROR, url: state.url};
}

/**
 * Whether the model-supplied `url` is http(s) and, unless private network
 * access is allowed, does not target a loopback, private, link-local or
 * internal host.
 *
 * Hostnames are resolved with DNS in Node.js. A browser cannot resolve them,
 * so there the check is limited to the hostname and IP literals. Like every
 * pre-flight lookup, the DNS check leaves a time-of-check/time-of-use window:
 * the browser resolves the name again when it connects.
 */
async function isSafeNavigationUrl(
  url: string,
  allowPrivateNetworkAccess: boolean,
): Promise<boolean> {
  // A browser ends the authority at "\", so in
  // `http://169.254.169.254\@example.com/` it connects to 169.254.169.254.
  // Refuse such urls rather than depend on which parser reads them.
  if (URL_AUTHORITY.exec(url)?.[1].includes('\\')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = normalizeHost(parsed.hostname);
  if (!isHttpUrl(parsed) || !hostname) {
    return false;
  }
  if (allowPrivateNetworkAccess) {
    return true;
  }
  if (isBlockedHostname(hostname)) {
    return false;
  }
  if (isBrowser() && !isIpAddress(hostname)) {
    return true;
  }
  try {
    const addresses = await resolveHostAddresses(hostname);
    return !addresses.some(isNonGlobalAddress);
  } catch {
    return false;
  }
}

/** Whether a hostname designates loopback or internal infrastructure. */
function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  return (
    BLOCKED_HOSTNAMES.has(normalized) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/** Builds an object schema whose properties are all required by default. */
function objectSchema(
  properties: Record<string, Schema>,
  required: string[] = Object.keys(properties),
): Schema {
  return {type: Type.OBJECT, properties, required};
}

/**
 * Reads a numeric argument. `fallback` is used when the model omitted it.
 *
 * @throws {Error} If the argument is missing with no fallback, or is not a
 *     finite number.
 */
function readNumber(
  args: Record<string, unknown>,
  name: string,
  fallback?: unknown,
): number {
  const value = args[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(argumentError(name, 'a number', value));
  }
  return value;
}

/** Reads a required string argument. */
function readString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') {
    throw new Error(argumentError(name, 'a string', value));
  }
  return value;
}

/** Reads a boolean argument, using `fallback` when the model omitted it. */
function readBoolean(
  args: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name] ?? fallback;
  if (typeof value !== 'boolean') {
    throw new Error(argumentError(name, 'a boolean', value));
  }
  return value;
}

/**
 * Reads an argument with `read`, or returns `undefined` when the model omitted
 * it, so the computer's own default applies.
 */
function readOptional<T>(
  args: Record<string, unknown>,
  name: string,
  read: (args: Record<string, unknown>, name: string) => T,
): T | undefined {
  return args[name] === undefined ? undefined : read(args, name);
}

/** Reads a required list of strings. */
function readStringArray(
  args: Record<string, unknown>,
  name: string,
): string[] {
  const value = args[name];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error(argumentError(name, 'a list of strings', value));
  }
  return value;
}

/** Reads the `direction` argument, using `fallback` when it is omitted. */
function readDirection(
  args: Record<string, unknown>,
  fallback?: ScrollDirection,
): ScrollDirection {
  const value = args['direction'] ?? fallback;
  const direction = SCROLL_DIRECTIONS.find((d) => d === value);
  if (!direction) {
    throw new Error(
      argumentError('direction', 'one of up, down, left, right', value),
    );
  }
  return direction;
}

function argumentError(name: string, expected: string, value: unknown): string {
  return value === undefined
    ? `Missing required argument '${name}'.`
    : `Argument '${name}' must be ${expected}, got ${typeof value}.`;
}
