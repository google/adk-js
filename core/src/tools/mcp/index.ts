/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Entry point for `@google/adk/tools/mcp`.
 *
 * Everything here is also re-exported from `@google/adk`, so importing it from
 * the root keeps working. This subpath exists so that an application using MCP
 * can pull in the MCP tools — and only the MCP tools — without evaluating the
 * whole ADK barrel, and so that the `@modelcontextprotocol/sdk` optional peer
 * dependency has an obvious, documented home.
 */

export * from './load_mcp_resource_tool.js';
export * from './mcp_session_manager.js';
export * from './mcp_tool.js';
export * from './mcp_toolset.js';
