/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The tool-facing names for the unified agent context.
 *
 * `ToolContext` and `CallbackContext` are aliases of {@link Context}, not
 * subclasses, so a context the framework builds satisfies either name. This
 * mirrors `adk-python`'s `google.adk.tools.tool_context`, which binds
 * `ToolContext = Context` and re-exports `CallbackContext` and the three auth
 * names from the same module.
 */

export {
  Context as CallbackContext,
  Context as ToolContext,
} from '../agents/context.js';
export type {AuthCredential} from '../auth/auth_credential.js';
export {AuthHandler} from '../auth/auth_handler.js';
export type {AuthConfig} from '../auth/auth_tool.js';
