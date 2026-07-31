/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Side-effect-only module that registers the engine's built-in node builders
 * (see {@link ./utils/workflow_graph_utils.js}). Importing it guarantees that
 * `node()` and graph parsing can turn a plain function, tool, or parallel
 * wrapper into a node even when the public workflow barrel is not the entry
 * point (e.g. code that imports `workflow.js`/`node.js` directly).
 *
 * The engine core stays decoupled from the concrete node classes; this module
 * is the single place that pulls them in for registration. Later parts add
 * their node modules here (the LLM agent wrapper in Part 7).
 */
import './nodes/function_node.js';
import './nodes/parallel_worker.js';
import './nodes/tool_node.js';
