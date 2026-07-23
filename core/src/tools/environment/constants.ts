/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/** Default execution timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Maximum characters returned to the LLM per tool call. */
export const MAX_OUTPUT_CHARS = 30000;

// ---------------------------------------------------------------------------
// System instruction templates
// ---------------------------------------------------------------------------

export const ENVIRONMENT_INSTRUCTION = `\
Your environment is at {working_dir}/

# Environment Rules

DO:
- Chain sequential, dependent commands with \`&&\` in a single \`Execute\` call
- To read existing files, always use the \`ReadFile\` tool. Use \`EditFile\` to modify existing files.

DON'T:
- Use \`Execute\` to run cat, head, or tail when \`ReadFile\` tools can do the job
- Combine \`EditFile\` or \`ReadFile\` with \`Execute\` in the same response (Instead, call the file tool first, then \`Execute\` in the next turn)
- Use multiple \`Execute\` calls for dependent commands (they run in parallel)
`;
