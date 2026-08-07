/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {ResumabilityConfig} from './resumability_config.js';

const VALID_APP_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Ensures the provided application name is safe and intuitive.
 */
export function validateAppName(name: string): void {
  if (!VALID_APP_NAME_RE.test(name)) {
    throw new Error(
      `Invalid app name '${name}': must start with a letter and can only consist of letters, digits, underscores, and hyphens.`,
    );
  }
  if (name === 'user') {
    throw new Error("App name cannot be 'user'; reserved for end-user input.");
  }
}

/**
 * A unique symbol to identify ADK App classes.
 * Defined once and shared by all App instances.
 */
const APP_SIGNATURE_SYMBOL = Symbol.for('google.adk.app');

/**
 * Type guard to check if an object is an instance of App.
 * @param obj The object to check.
 * @returns True if the object is an instance of App, false otherwise.
 */
export function isApp(obj: unknown): obj is App {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    APP_SIGNATURE_SYMBOL in obj &&
    obj[APP_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Options for initializing an App.
 */
export interface AppOptions {
  name: string;
  rootAgent: BaseAgent;
  plugins?: BasePlugin[];
  resumabilityConfig?: ResumabilityConfig;
}

/**
 * Represents an LLM-backed agentic application.
 *
 * An `App` is the top-level container for an agentic system powered by LLMs.
 * It manages a root agent (`rootAgent`), which serves as the entry point for execution.
 *
 * Exactly one `rootAgent` must be provided.
 *
 * The `plugins` are application-wide components that provide shared capabilities
 * and services to the entire system.
 */
export class App {
  readonly [APP_SIGNATURE_SYMBOL] = true;

  readonly name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly rootAgent: BaseAgent | any;
  readonly plugins: BasePlugin[];
  readonly resumabilityConfig?: ResumabilityConfig;

  constructor(options: AppOptions) {
    validateAppName(options.name);

    if (options.rootAgent === undefined || options.rootAgent === null) {
      throw new Error('rootAgent must be provided.');
    }

    if (!isBaseAgent(options.rootAgent)) {
      throw new TypeError(
        `rootAgent must be a BaseAgent instance, got ${
          (options.rootAgent as {constructor?: {name?: string}})?.constructor
            ?.name ?? typeof options.rootAgent
        }`,
      );
    }

    this.name = options.name;
    this.rootAgent = options.rootAgent;
    this.plugins = options.plugins ?? [];
    this.resumabilityConfig = options.resumabilityConfig;
  }
}
