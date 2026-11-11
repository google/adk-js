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
 * `ToolContext = Context`.
 *
 * Python also re-exports `AuthHandler`, `AuthConfig` and `AuthCredential` from
 * this module. adk-js does not: the package `exports` map has no entry for this
 * path, so no consumer can import them from here, and all three already ship
 * from the package root.
 */

export {
  Context as CallbackContext,
  Context as ToolContext,
} from '../agents/context.js';
