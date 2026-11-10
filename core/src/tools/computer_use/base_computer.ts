/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {experimental} from '../../utils/experimental.js';

/**
 * The environment a {@link BaseComputer} operates in.
 */
export enum ComputerEnvironment {
  /** Defaults to browser. */
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  /** Operates in a web browser. */
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

/**
 * The current state of the computer environment, returned by every
 * {@link BaseComputer} action.
 */
export interface ComputerState {
  /** The screenshot in PNG format. */
  screenshot?: Uint8Array;
  /** The current URL of the webpage being displayed. */
  url?: string;
}

/** A direction to scroll in. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Throws when the computer use feature is turned off.
 *
 * @throws {Error} If `ADK_DISABLE_COMPUTER_USE` or a feature override turned
 *     the feature off.
 */
export function checkComputerUseEnabled(): void {
  if (!isFeatureEnabled(FeatureName.COMPUTER_USE)) {
    throw new Error(`Feature ${FeatureName.COMPUTER_USE} is not enabled.`);
  }
}

const BASE_COMPUTER_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseComputer');

/**
 * Type guard to check if an object is an instance of {@link BaseComputer}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseComputer, false otherwise.
 */
export function isBaseComputer(obj: unknown): obj is BaseComputer {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_COMPUTER_SIGNATURE_SYMBOL in obj &&
    obj[BASE_COMPUTER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Defines an interface for computer environments.
 *
 * This abstract base class defines the standard interface for controlling
 * computer environments, including web browsers and other interactive systems.
 * Coordinates passed to the action methods are absolute pixel values, scaled
 * to the width and height returned by {@link screenSize}.
 *
 * The optional methods (`doubleClick`, `tripleClick`, `middleClick`,
 * `rightClick`, `mouseDown`, `mouseUp`, `keyDown` and `keyUp`) are exposed to
 * the model only when a subclass implements them.
 *
 * The Gemini 3.x actions `click`, `move`, `type`, `scroll`, `take_screenshot`,
 * `press_key` and `hotkey` are always exposed. Each one calls the subclass
 * method of the same name (`click`, `move`, `type`, `scroll`,
 * `takeScreenshot`, `pressKey`, `hotkey`) when it is defined, and otherwise
 * calls the matching predefined method.
 */
@experimental
export abstract class BaseComputer {
  /** A unique symbol to identify ADK base computer class. */
  readonly [BASE_COMPUTER_SIGNATURE_SYMBOL] = true;

  constructor() {
    checkComputerUseEnabled();
  }

  /** Initializes the computer. */
  async initialize(): Promise<void> {}

  /** Cleans up the resources of the computer. */
  async close(): Promise<void> {}

  /**
   * Called before each tool invocation to prepare resources.
   *
   * Override this to set up session-level resources (a sandbox, tokens, and so
   * on), using the state of `toolContext` for persistence across invocations.
   *
   * @param _toolContext The tool context with session state access.
   */
  async prepare(_toolContext: Context): Promise<void> {}

  /**
   * Returns the screen size of the environment.
   *
   * @returns A tuple of (width, height) in pixels.
   */
  abstract screenSize(): Promise<[number, number]>;

  /** Returns the environment of the computer. */
  abstract environment(): Promise<ComputerEnvironment>;

  /**
   * Opens the web browser.
   *
   * @returns The current state after opening the browser.
   */
  abstract openWebBrowser(): Promise<ComputerState>;

  /**
   * Clicks at a specific x, y coordinate on the webpage.
   *
   * @param x The x-coordinate to click at.
   * @param y The y-coordinate to click at.
   * @returns The current state after clicking.
   */
  abstract clickAt(x: number, y: number): Promise<ComputerState>;

  /**
   * Hovers at a specific x, y coordinate on the webpage.
   *
   * May be used to explore sub-menus that appear on hover.
   *
   * @param x The x-coordinate to hover at.
   * @param y The y-coordinate to hover at.
   * @returns The current state after hovering.
   */
  abstract hoverAt(x: number, y: number): Promise<ComputerState>;

  /**
   * Types text at a specific x, y coordinate.
   *
   * @param x The x-coordinate to type at.
   * @param y The y-coordinate to type at.
   * @param text The text to type.
   * @param pressEnter Whether to press ENTER after typing. The toolset passes
   *     `true` when the model does not say.
   * @param clearBeforeTyping Whether to clear existing content before typing.
   *     The toolset passes `true` when the model does not say.
   * @returns The current state after typing.
   */
  abstract typeTextAt(
    x: number,
    y: number,
    text: string,
    pressEnter?: boolean,
    clearBeforeTyping?: boolean,
  ): Promise<ComputerState>;

  /**
   * Types text into the currently focused element.
   *
   * By default, this calls {@link keyCombination} once per character in `text`
   * (and once for `"Enter"` when `pressEnter` is true). Because
   * `keyCombination` is designed for key names and typically captures a new
   * screenshot on every call, this fallback costs one round trip and screenshot
   * per character, and relies on the backend accepting single characters in
   * `keyCombination`. Subclasses should override this method to use native
   * bulk text input.
   *
   * @param text The text to type.
   * @param pressEnter Whether to press ENTER after typing.
   * @returns The current state after typing.
   */
  async typeText(text: string, pressEnter = false): Promise<ComputerState> {
    let state: ComputerState | undefined;
    for (const char of text) {
      state = await this.keyCombination([char]);
    }
    if (pressEnter) {
      state = await this.keyCombination(['Enter']);
    }
    return state ?? this.currentState();
  }

  /**
   * Scrolls the entire webpage up, down, left or right.
   *
   * @param direction The direction to scroll.
   * @returns The current state after scrolling.
   */
  abstract scrollDocument(direction: ScrollDirection): Promise<ComputerState>;

  /**
   * Scrolls up, down, right, or left at an x, y coordinate by magnitude.
   *
   * @param x The x-coordinate to scroll at.
   * @param y The y-coordinate to scroll at.
   * @param direction The direction to scroll.
   * @param magnitude The amount to scroll.
   * @returns The current state after scrolling.
   */
  abstract scrollAt(
    x: number,
    y: number,
    direction: ScrollDirection,
    magnitude: number,
  ): Promise<ComputerState>;

  /**
   * Waits for n seconds to allow unfinished webpage processes to complete.
   *
   * @param seconds The number of seconds to wait.
   * @returns The current state after waiting.
   */
  abstract wait(seconds: number): Promise<ComputerState>;

  /**
   * Navigates back to the previous webpage in the browser history.
   *
   * @returns The current state after navigating back.
   */
  abstract goBack(): Promise<ComputerState>;

  /**
   * Navigates forward to the next webpage in the browser history.
   *
   * @returns The current state after navigating forward.
   */
  abstract goForward(): Promise<ComputerState>;

  /**
   * Directly jumps to a search engine home page.
   *
   * Used when you need to start with a search, for example because the current
   * website doesn't have the information needed or a new task is being
   * started.
   *
   * @returns The current state after navigating to search.
   */
  abstract search(): Promise<ComputerState>;

  /**
   * Navigates directly to a specified URL.
   *
   * @param url The URL to navigate to.
   * @returns The current state after navigation.
   */
  abstract navigate(url: string): Promise<ComputerState>;

  /**
   * Presses keyboard keys and combinations, such as "control+c" or "enter".
   *
   * @param keys The keys to press in combination.
   * @returns The current state after the key press.
   */
  abstract keyCombination(keys: string[]): Promise<ComputerState>;

  /**
   * Drags an element from an x, y coordinate and drops it at a destination
   * coordinate.
   *
   * @param x The x-coordinate to start dragging from.
   * @param y The y-coordinate to start dragging from.
   * @param destinationX The x-coordinate to drop at.
   * @param destinationY The y-coordinate to drop at.
   * @returns The current state after drag and drop.
   */
  abstract dragAndDrop(
    x: number,
    y: number,
    destinationX: number,
    destinationY: number,
  ): Promise<ComputerState>;

  /**
   * Returns the current state of the current webpage.
   *
   * @returns The current environment state.
   */
  abstract currentState(): Promise<ComputerState>;

  /** Double-clicks at a specific x, y coordinate. */
  doubleClick?(x: number, y: number, button?: string): Promise<ComputerState>;

  /** Triple-clicks at a specific x, y coordinate. */
  tripleClick?(x: number, y: number, button?: string): Promise<ComputerState>;

  /** Clicks the middle mouse button at a specific x, y coordinate. */
  middleClick?(x: number, y: number, button?: string): Promise<ComputerState>;

  /** Clicks the right mouse button at a specific x, y coordinate. */
  rightClick?(x: number, y: number, button?: string): Promise<ComputerState>;

  /** Presses a mouse button down at a specific x, y coordinate. */
  mouseDown?(x: number, y: number, button?: string): Promise<ComputerState>;

  /** Releases a mouse button at a specific x, y coordinate. */
  mouseUp?(x: number, y: number, button?: string): Promise<ComputerState>;

  /** Presses a keyboard key down and holds it. */
  keyDown?(key: string): Promise<ComputerState>;

  /** Releases a keyboard key. */
  keyUp?(key: string): Promise<ComputerState>;

  /**
   * Clicks at a specific x, y coordinate with the given mouse button.
   *
   * When defined, the `click` action calls this instead of {@link clickAt}
   * and passes the model's `button`.
   */
  click?(x: number, y: number, button?: string): Promise<ComputerState>;

  /**
   * Moves the cursor to a specific x, y coordinate.
   *
   * When defined, the `move` action calls this instead of {@link hoverAt}.
   */
  move?(x: number, y: number): Promise<ComputerState>;

  /**
   * Types text into the currently focused element.
   *
   * When defined, the `type` action calls this instead of {@link typeText}.
   * `pressEnter` is `undefined` when the model does not say.
   */
  type?(text: string, pressEnter?: boolean): Promise<ComputerState>;

  /**
   * Scrolls at a specific x, y coordinate by a number of pixels.
   *
   * When defined, the `scroll` action calls this instead of {@link scrollAt}.
   * `magnitudeInPixels` is `undefined` when the model does not say.
   */
  scroll?(
    x: number,
    y: number,
    direction: ScrollDirection,
    magnitudeInPixels?: number,
  ): Promise<ComputerState>;

  /**
   * Takes a screenshot of the current state.
   *
   * When defined, the `take_screenshot` action calls this instead of
   * {@link currentState}.
   */
  takeScreenshot?(): Promise<ComputerState>;

  /**
   * Presses a single keyboard key.
   *
   * When defined, the `press_key` action calls this instead of
   * {@link keyCombination}.
   */
  pressKey?(key: string): Promise<ComputerState>;

  /**
   * Presses a combination of keyboard keys simultaneously.
   *
   * When defined, the `hotkey` action calls this instead of
   * {@link keyCombination}.
   */
  hotkey?(keys: string[]): Promise<ComputerState>;
}
