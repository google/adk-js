/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  FunctionTool,
  SingleAgentCallback,
  ToolInputParameters,
} from '@google/adk';

/**
 * A function tool of any parameter shape.
 *
 * Bare `FunctionTool` means `FunctionTool<undefined>` — a tool that takes no
 * arguments — so it cannot hold the schema-carrying tools this registry is
 * given.
 */
export type AnyFunctionTool = FunctionTool<ToolInputParameters>;

export class IntegrationRegistry {
  private tools = new Map<string, AnyFunctionTool>();
  private beforeAgentCallbacks = new Map<string, SingleAgentCallback>();
  private afterAgentCallbacks = new Map<string, SingleAgentCallback>();
  private plugins = new Map<string, BasePlugin>();

  summary(): string {
    return (
      `${this.tools.size} tools, ` +
      `${this.beforeAgentCallbacks.size} before agent callbacks, ` +
      `${this.afterAgentCallbacks.size} after agent callbacks, ` +
      `and ${this.plugins.size} plugins.`
    );
  }

  registerTool(name: string, tool: AnyFunctionTool) {
    this.tools.set(name, tool);
  }

  getTool(name: string): AnyFunctionTool | undefined {
    return this.tools.get(name);
  }

  registerBeforeAgentCallback(name: string, callback: SingleAgentCallback) {
    this.beforeAgentCallbacks.set(name, callback);
  }

  getBeforeAgentCallback(name: string): SingleAgentCallback | undefined {
    return this.beforeAgentCallbacks.get(name);
  }

  registerAfterAgentCallback(name: string, callback: SingleAgentCallback) {
    this.afterAgentCallbacks.set(name, callback);
  }

  getAfterAgentCallback(name: string): SingleAgentCallback | undefined {
    return this.afterAgentCallbacks.get(name);
  }

  registerPlugin(name: string, plugin: BasePlugin) {
    this.plugins.set(name, plugin);
  }

  getPlugin(name: string): BasePlugin | undefined {
    return this.plugins.get(name);
  }
}
