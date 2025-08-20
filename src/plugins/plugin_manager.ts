/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin} from './base_plugin.js';

// A type alias for the names of the available plugin callbacks.
type PluginCallbackName = keyof Omit<BasePlugin, 'name'>;

/**
 * Manages the registration and execution of plugins.
 * Implements an "early exit" strategy.
 */
export class PluginManager {
  private readonly plugins: BasePlugin[] = [];

  constructor(plugins?: BasePlugin[]) {
    if (plugins) {
      for (const plugin of plugins) {
        this.registerPlugin(plugin);
      }
    }
  }

  registerPlugin(plugin: BasePlugin): void {
    if (this.plugins.some(p => p.name === plugin.name)) {
      throw new Error(`Plugin with name '${plugin.name}' already registered.`);
    }
    this.plugins.push(plugin);
    // TODO: Replace with structured logging when available.
    console.debug(`[PluginManager] Plugin '${plugin.name}' registered.`);
  }

  getPlugin<T extends BasePlugin>(pluginName: string): T|undefined {
    return this.plugins.find(p => p.name === pluginName) as T | undefined;
  }

  getPluginCount(): number {
    return this.plugins.length;
  }

  // --- Specific Callback Runners (Type-Safe Wrappers) ---
  // We use Parameters and Awaited<ReturnType> to infer types dynamically from BasePlugin.

  async runOnUserMessageCallback(
      params: Parameters<BasePlugin['onUserMessageCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['onUserMessageCallback']>>> {
    return this.runCallbacks('onUserMessageCallback', params);
  }

  async runBeforeRunCallback(
      params: Parameters<BasePlugin['beforeRunCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['beforeRunCallback']>>> {
    return this.runCallbacks('beforeRunCallback', params);
  }

  async runOnEventCallback(
      params: Parameters<BasePlugin['onEventCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['onEventCallback']>>> {
    return this.runCallbacks('onEventCallback', params);
  }

  async runAfterRunCallback(
      params: Parameters<BasePlugin['afterRunCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['afterRunCallback']>>> {
    return this.runCallbacks('afterRunCallback', params);
  }

  async runBeforeAgentCallback(
      params: Parameters<BasePlugin['beforeAgentCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['beforeAgentCallback']>>> {
    return this.runCallbacks('beforeAgentCallback', params);
  }

  async runAfterAgentCallback(
      params: Parameters<BasePlugin['afterAgentCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['afterAgentCallback']>>> {
    return this.runCallbacks('afterAgentCallback', params);
  }

  async runBeforeModelCallback(
      params: Parameters<BasePlugin['beforeModelCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['beforeModelCallback']>>> {
    return this.runCallbacks('beforeModelCallback', params);
  }

  async runAfterModelCallback(
      params: Parameters<BasePlugin['afterModelCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['afterModelCallback']>>> {
    return this.runCallbacks('afterModelCallback', params);
  }

  async runOnModelErrorCallback(
      params: Parameters<BasePlugin['onModelErrorCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['onModelErrorCallback']>>> {
    return this.runCallbacks('onModelErrorCallback', params);
  }

  async runBeforeToolCallback(
      params: Parameters<BasePlugin['beforeToolCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['beforeToolCallback']>>> {
    return this.runCallbacks('beforeToolCallback', params);
  }

  async runAfterToolCallback(
      params: Parameters<BasePlugin['afterToolCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['afterToolCallback']>>> {
    return this.runCallbacks('afterToolCallback', params);
  }

  async runOnToolErrorCallback(
      params: Parameters<BasePlugin['onToolErrorCallback']>[0]):
      Promise<Awaited<ReturnType<BasePlugin['onToolErrorCallback']>>> {
    return this.runCallbacks('onToolErrorCallback', params);
  }

  /**
   * Executes a specific callback for all registered plugins until one returns a value.
   */
  private async runCallbacks<K extends PluginCallbackName>(
      callbackName: K,
      args: Parameters<BasePlugin[K]>[0]
  ): Promise<Awaited<ReturnType<BasePlugin[K]>>> {
    for (const plugin of this.plugins) {
      // Type assertion is safe here due to the wrapper methods ensuring type alignment.
      const callbackMethod = plugin[callbackName] as (args: unknown) => Promise<unknown>;

      try {
        // Use .call() to ensure 'this' context is the plugin instance.
        const result = await callbackMethod.call(plugin, args);

        if (result !== undefined) {
          // Early exit
          console.debug(
              `[PluginManager] Plugin '${plugin.name}' returned a value for '${
                  callbackName}', exiting early.`);
          return result as Awaited<ReturnType<BasePlugin[K]>>;
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        const errorMessage = `Error in plugin '${plugin.name}' during '${
            callbackName}' callback: ${error.message}`;
        console.error(`[PluginManager] ${errorMessage}`, error.stack);
        // Re-throw to ensure failures in plugins are not silently ignored.
        throw new Error(errorMessage, {cause: error});
      }
    }

    return undefined as Awaited<ReturnType<BasePlugin[K]>>;
  }
}
