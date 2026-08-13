/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {App, isApp, validateAppName} from '../../src/apps/app.js';
import {createResumabilityConfig} from '../../src/apps/resumability_config.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

class DummyAgent extends BaseAgent {
  constructor(name = 'dummy_agent') {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

class DummyPlugin extends BasePlugin {
  constructor(name = 'dummy_plugin') {
    super(name);
  }
}

describe('validateAppName', () => {
  it('allows valid app names', () => {
    expect(() => validateAppName('my_app')).not.toThrow();
    expect(() => validateAppName('MyApp123-test')).not.toThrow();
    expect(() => validateAppName('A')).not.toThrow();
  });

  it('rejects names starting with numbers or invalid symbols', () => {
    expect(() => validateAppName('123app')).toThrow(
      /Invalid app name '123app'/,
    );
    expect(() => validateAppName('-app')).toThrow(/Invalid app name '-app'/);
    expect(() => validateAppName('my app')).toThrow(
      /Invalid app name 'my app'/,
    );
    expect(() => validateAppName('my/app')).toThrow(
      /Invalid app name 'my\/app'/,
    );
  });

  it("rejects 'user' as app name", () => {
    expect(() => validateAppName('user')).toThrow(
      /reserved for end-user input/,
    );
  });
});

describe('App', () => {
  it('creates an App with required options and checks isApp', () => {
    const rootAgent = new DummyAgent('root');
    const app = new App({
      name: 'test_app',
      rootAgent,
    });

    expect(app.name).toBe('test_app');
    expect(app.rootAgent).toBe(rootAgent);
    expect(app.plugins).toEqual([]);
    expect(isApp(app)).toBe(true);
    expect(isApp({})).toBe(false);
    expect(isApp(rootAgent)).toBe(false);
  });

  it('creates an App with plugins', () => {
    const rootAgent = new DummyAgent('root');
    const plugin = new DummyPlugin('p1');
    const app = new App({
      name: 'configured_app',
      rootAgent,
      plugins: [plugin],
    });

    expect(app.plugins).toEqual([plugin]);
  });

  it('throws if rootAgent is missing or not a BaseAgent', () => {
    expect(
      () =>
        new App({
          name: 'test_app',
          rootAgent: undefined as unknown as BaseAgent,
        }),
    ).toThrow('rootAgent must be provided.');
    expect(
      () =>
        new App({
          name: 'test_app',
          rootAgent: {name: 'fake'} as unknown as BaseAgent,
        }),
    ).toThrow(/expected a BaseAgent, a Workflow, or a node-like value/);
  });

  it('accepts a bare Workflow as the root and adapts it', () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'done', {name: 'step'})]],
    });

    const app = new App({name: 'test_app', rootAgent: workflow});

    // Normalized at the boundary, so everything downstream of an App still
    // receives an agent.
    expect(app.rootAgent).toBeInstanceOf(WorkflowAgent);
    expect(app.rootAgent.name).toBe('wf');
  });

  it('creates an App with resumabilityConfig', () => {
    const rootAgent = new DummyAgent('root');
    const resumabilityConfig = createResumabilityConfig({isResumable: true});
    const app = new App({
      name: 'resumable_app',
      rootAgent,
      resumabilityConfig,
    });

    expect(app.resumabilityConfig).toBe(resumabilityConfig);
    expect(app.resumabilityConfig?.isResumable).toBe(true);
  });
});
