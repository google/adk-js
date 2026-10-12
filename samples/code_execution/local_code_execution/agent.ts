/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local code execution
 * ../../../docs/guides/code_executors/index.md
 *
 * A minimal agent that writes and executes Python locally with
 * `UnsafeLocalCodeExecutor`.
 *
 * When the model emits a ```python or ```tool_code fence, the response
 * processor extracts the code, runs it in a local `python3` subprocess via
 * `UnsafeLocalCodeExecutor`, and feeds the printed output back to the model in
 * a ```tool_output block so it can summarize the result.
 *
 * REQUIRES an API key and `python3` on PATH. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/code_execution/local_code_execution/agent.ts
 * Try "Calculate the first 15 Fibonacci numbers and their sum.".
 */

import {LlmAgent, UnsafeLocalCodeExecutor} from '@google/adk';

const INSTRUCTION = `
You answer calculation and data questions by writing Python code and running it.

- Write Python code inside a \`\`\`python block. Only the first code block in a response is executed.
- Always print intermediate and final values with \`print(...)\` so the output appears in the \`\`\`tool_output block.
- Never write a \`\`\`tool_output block yourself.
- Variables and imports do not persist across turns; import standard library modules in every block that needs them.
- Once the execution output answers the user's question, explain the result clearly in plain text without another code block.
`;

const executor = new UnsafeLocalCodeExecutor({timeoutSeconds: 30});
executor.codeBlockDelimiters = [
  ['```python\n', '\n```'],
  ['```tool_code\n', '\n```'],
];

export const rootAgent = new LlmAgent({
  name: 'local_code_execution_agent',
  model: 'gemini-flash-latest',
  description:
    'Executes Python code blocks locally to solve math and data tasks.',
  instruction: INSTRUCTION,
  codeExecutor: executor,
});
