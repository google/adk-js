/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AppOptions, InvocationContext} from '@google/adk';
import {App, BaseAgent, isApp, validateAppName} from '@google/adk';
import {describe, expect, it} from 'vitest';

class DummyAgent extends BaseAgent {
  constructor(name = 'dummy_agent') {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

describe('apps/app exports from @google/adk', () => {
  it('exports App as the real class', () => {
    const app = new App({name: 'barrel_app', rootAgent: new DummyAgent()});

    expect(app.name).toBe('barrel_app');
  });

  it('exports isApp', () => {
    const app = new App({name: 'barrel_app', rootAgent: new DummyAgent()});

    expect(isApp(app)).toBe(true);
    expect(isApp({name: 'barrel_app'})).toBe(false);
  });

  it('exports validateAppName with its rules intact', () => {
    expect(() => validateAppName('barrel_app')).not.toThrow();
    expect(() => validateAppName('1_app')).toThrow(/Invalid app name '1_app'/);
    expect(() => validateAppName('user')).toThrow(
      /reserved for end-user input/,
    );
  });

  it('exports AppOptions as a type', () => {
    // `npm run ts:check` is what pins this: an unexported `AppOptions` fails
    // the annotation below at compile time, not at run time.
    const options: AppOptions = {
      name: 'barrel_app',
      rootAgent: new DummyAgent(),
    };

    expect(new App(options).name).toBe('barrel_app');
  });
});
