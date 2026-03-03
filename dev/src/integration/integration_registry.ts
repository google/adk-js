/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, FunctionTool, SingleAgentCallback} from '@google/adk';

export class IntegrationRegistry {
  private tools = new Map<string, FunctionTool>();
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

  registerTool(name: string, tool: FunctionTool) {
    this.tools.set(name, tool);
  }

  getTool(name: string): FunctionTool | undefined {
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
