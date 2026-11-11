/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  FunctionTool,
  LoggingPlugin,
  SingleAgentCallback,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';

describe('IntegrationRegistry', () => {
  let registry: IntegrationRegistry;

  beforeEach(() => {
    registry = new IntegrationRegistry();
  });

  it('should register and retrieve tools', () => {
    const tool = new FunctionTool({
      name: 'test_tool',
      description: 'A test tool',
      execute: async () => ({result: 'success'}),
    });

    registry.registerTool('test_tool', tool);
    const retrieved = registry.getTool('test_tool');

    expect(retrieved).toBe(tool);
    expect(registry.getTool('non_existent')).toBeUndefined();
  });

  it('should register and retrieve before agent callbacks', () => {
    const callback: SingleAgentCallback = async () => {
      return undefined;
    };
    const name = 'test_before_callback';

    registry.registerBeforeAgentCallback(name, callback);
    const retrieved = registry.getBeforeAgentCallback(name);

    expect(retrieved).toBe(callback);
    expect(registry.getBeforeAgentCallback('non_existent')).toBeUndefined();
  });

  it('should register and retrieve after agent callbacks', () => {
    const callback: SingleAgentCallback = async () => {
      return undefined;
    };
    const name = 'test_after_callback';

    registry.registerAfterAgentCallback(name, callback);
    const retrieved = registry.getAfterAgentCallback(name);

    expect(retrieved).toBe(callback);
    expect(registry.getAfterAgentCallback('non_existent')).toBeUndefined();
  });

  it('should register and retrieve plugins', () => {
    const plugin = {} as unknown as BasePlugin;
    registry.registerPlugin('test_plugin', plugin);
    const retrieved = registry.getPlugin('test_plugin');

    expect(retrieved).toBe(plugin);
    expect(registry.getPlugin('non_existent')).toBeUndefined();
  });

  it('should summarize an empty registry', () => {
    expect(registry.summary()).toBe(
      '0 tools, 0 before agent callbacks, 0 after agent callbacks, and 0 plugins.',
    );
  });

  it('should count registered entries in the summary', () => {
    const tool = new FunctionTool({
      name: 'test_tool',
      description: 'A test tool',
      execute: async () => ({result: 'success'}),
    });
    const callback: SingleAgentCallback = async () => {
      return undefined;
    };

    registry.registerTool('test_tool', tool);
    registry.registerBeforeAgentCallback('test_before_callback', callback);
    registry.registerAfterAgentCallback('test_after_callback', callback);
    registry.registerPlugin('test_plugin', new LoggingPlugin('test_plugin'));

    expect(registry.summary()).toBe(
      '1 tools, 1 before agent callbacks, 1 after agent callbacks, and 1 plugins.',
    );
  });
});
