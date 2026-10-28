/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  Context,
  FeatureName,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
  isBaseComputer,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SCREENSHOT = new Uint8Array([1, 2, 3]);

class FakeComputer extends BaseComputer {
  readonly keyPresses: string[][] = [];

  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  openWebBrowser(): Promise<ComputerState> {
    return this.state('opened');
  }
  clickAt(): Promise<ComputerState> {
    return this.state('clicked');
  }
  hoverAt(): Promise<ComputerState> {
    return this.state('hovered');
  }
  typeTextAt(): Promise<ComputerState> {
    return this.state('typed-at');
  }
  scrollDocument(): Promise<ComputerState> {
    return this.state('scrolled');
  }
  scrollAt(): Promise<ComputerState> {
    return this.state('scrolled-at');
  }
  wait(): Promise<ComputerState> {
    return this.state('waited');
  }
  goBack(): Promise<ComputerState> {
    return this.state('back');
  }
  goForward(): Promise<ComputerState> {
    return this.state('forward');
  }
  search(): Promise<ComputerState> {
    return this.state('search');
  }
  navigate(url: string): Promise<ComputerState> {
    return Promise.resolve({screenshot: SCREENSHOT, url});
  }
  keyCombination(keys: string[]): Promise<ComputerState> {
    this.keyPresses.push(keys);
    return this.state(`keys-${this.keyPresses.length}`);
  }
  dragAndDrop(): Promise<ComputerState> {
    return this.state('dragged');
  }
  currentState(): Promise<ComputerState> {
    return this.state('current');
  }

  private state(page: string): Promise<ComputerState> {
    return Promise.resolve({
      screenshot: SCREENSHOT,
      url: `https://example.com/${page}`,
    });
  }
}

function makeContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'agent', model: 'gemini-flash-latest'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

describe('ComputerEnvironment', () => {
  it('uses the wire values of the computer use API', () => {
    expect(ComputerEnvironment.ENVIRONMENT_UNSPECIFIED).toBe(
      'ENVIRONMENT_UNSPECIFIED',
    );
    expect(ComputerEnvironment.ENVIRONMENT_BROWSER).toBe('ENVIRONMENT_BROWSER');
  });
});

describe('BaseComputer', () => {
  it('is recognized by isBaseComputer', () => {
    expect(isBaseComputer(new FakeComputer())).toBe(true);
    expect(isBaseComputer({clickAt: () => undefined})).toBe(false);
    expect(isBaseComputer(null)).toBe(false);
  });

  it('has no-op lifecycle methods by default', async () => {
    const computer = new FakeComputer();

    await expect(computer.initialize()).resolves.toBeUndefined();
    await expect(computer.prepare(makeContext())).resolves.toBeUndefined();
    await expect(computer.close()).resolves.toBeUndefined();
  });

  it('declares no optional actions by default', () => {
    const computer = new FakeComputer();

    expect(computer.doubleClick).toBeUndefined();
    expect(computer.keyDown).toBeUndefined();
  });

  describe('typeText', () => {
    it('presses each character, then Enter, by default', async () => {
      const computer = new FakeComputer();

      const state = await computer.typeText('cat', true);

      expect(computer.keyPresses).toEqual([['c'], ['a'], ['t'], ['Enter']]);
      expect(state.url).toBe('https://example.com/keys-4');
    });

    it('does not press Enter unless asked', async () => {
      const computer = new FakeComputer();

      await computer.typeText('hi');

      expect(computer.keyPresses).toEqual([['h'], ['i']]);
    });

    it('returns the current state when there is nothing to type', async () => {
      const computer = new FakeComputer();

      const state = await computer.typeText('');

      expect(computer.keyPresses).toEqual([]);
      expect(state.url).toBe('https://example.com/current');
    });
  });

  it('cannot be constructed while the feature is disabled', async () => {
    await withTemporaryFeatureOverride(FeatureName.COMPUTER_USE, false, () => {
      expect(() => new FakeComputer()).toThrow(
        'Feature COMPUTER_USE is not enabled.',
      );
    });
  });
});
