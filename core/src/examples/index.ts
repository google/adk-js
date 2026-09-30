/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Examples subsystem barrel export.
 *
 * Re-exports all `examples` modules (`Example`, `BaseExampleProvider`,
 * `VertexAiExampleStore`, `example_util`) alongside compatibility references
 * for `BaseCodeExecutor`, `BuiltInCodeExecutor`, `CodeExecutorContext`,
 * `ContainerCodeExecutor`, `UnsafeLocalCodeExecutor`, `VertexAiCodeExecutor`,
 * and `code_execution_utils`.
 */

export * from './base_example_provider.js';
export * from './example.js';
export * from './example_util.js';
export * from './vertex_ai_example_store.js';
