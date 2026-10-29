/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Computer use: an agent that drives a browser through `ComputerUseToolset`.
 *
 * `ComputerUseToolset` turns any `BaseComputer` into the predefined actions a
 * computer use model calls: `click_at`, `type_text_at`, `navigate` and so on,
 * plus their Gemini 3.x names. A real computer drives a browser or a remote
 * sandbox. To keep the sample free of a browser automation dependency,
 * `InMemoryBrowserComputer` below only records the page it is on and answers
 * every action with the same blank screenshot.
 *
 * REQUIRES an API key (the agent calls a live model) and a model that supports
 * the computer use tool. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/tools/computer_use/agent.ts
 * Try "open example.com and go back".
 */

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  LlmAgent,
  ScrollDirection,
} from '@google/adk';

/** A 1x1 transparent PNG, standing in for a real screenshot. */
const BLANK_SCREENSHOT = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

/**
 * A computer that keeps a browsing history in memory. It accepts every action
 * and reports the page it is on, which is enough for the toolset and the model
 * to run a full turn.
 */
class InMemoryBrowserComputer extends BaseComputer {
  private readonly history: string[] = ['about:blank'];
  private position = 0;

  async screenSize(): Promise<[number, number]> {
    return [1280, 720];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async openWebBrowser(): Promise<ComputerState> {
    return this.currentState();
  }

  async clickAt(_x: number, _y: number): Promise<ComputerState> {
    return this.currentState();
  }

  async hoverAt(_x: number, _y: number): Promise<ComputerState> {
    return this.currentState();
  }

  async typeTextAt(
    _x: number,
    _y: number,
    _text: string,
    _pressEnter?: boolean,
    _clearBeforeTyping?: boolean,
  ): Promise<ComputerState> {
    return this.currentState();
  }

  override async typeText(
    _text: string,
    _pressEnter?: boolean,
  ): Promise<ComputerState> {
    return this.currentState();
  }

  async scrollDocument(_direction: ScrollDirection): Promise<ComputerState> {
    return this.currentState();
  }

  async scrollAt(
    _x: number,
    _y: number,
    _direction: ScrollDirection,
    _magnitude: number,
  ): Promise<ComputerState> {
    return this.currentState();
  }

  async wait(_seconds: number): Promise<ComputerState> {
    return this.currentState();
  }

  async goBack(): Promise<ComputerState> {
    this.position = Math.max(0, this.position - 1);
    return this.currentState();
  }

  async goForward(): Promise<ComputerState> {
    this.position = Math.min(this.history.length - 1, this.position + 1);
    return this.currentState();
  }

  async search(): Promise<ComputerState> {
    return this.navigate('https://www.google.com/');
  }

  async navigate(url: string): Promise<ComputerState> {
    this.history.splice(this.position + 1, Infinity, url);
    this.position = this.history.length - 1;
    return this.currentState();
  }

  async keyCombination(_keys: string[]): Promise<ComputerState> {
    return this.currentState();
  }

  async dragAndDrop(
    _x: number,
    _y: number,
    _destinationX: number,
    _destinationY: number,
  ): Promise<ComputerState> {
    return this.currentState();
  }

  async currentState(): Promise<ComputerState> {
    return {screenshot: BLANK_SCREENSHOT, url: this.history[this.position]};
  }
}

export const rootAgent = new LlmAgent({
  name: 'browser_agent',
  model: 'gemini-flash-latest',
  description: 'Operates a web browser to complete tasks.',
  instruction:
    'You operate a web browser. Use the computer use actions to complete the ' +
    'task, then report the page you ended on.',
  tools: [
    new ComputerUseToolset({
      computer: new InMemoryBrowserComputer(),
      // Actions the task does not need are not offered to the model.
      excludedPredefinedFunctions: ['drag_and_drop'],
    }),
  ],
});
