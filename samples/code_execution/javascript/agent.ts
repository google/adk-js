/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JavaScript code execution
 * ../../../docs/guides/code_executors/index.md
 *
 * An agent that answers by writing JavaScript and running it with Node.js.
 *
 * The code execution processors find the first ```javascript (or ```js)
 * block in the model response, pass it to the executor as
 * `CodeExecutionLanguage.JAVASCRIPT`, and send the output back to the model
 * in a ```tool_output block. The model then writes the next step or the
 * answer. Both executors below run JavaScript as they are, so the sample needs
 * no custom executor. It only sets `codeBlockDelimiters` to the JavaScript
 * fences, so that a Python or shell block in a reply stays text.
 *
 * ADK_SAMPLE_CODE_EXECUTOR selects the executor:
 *   - `unsafe_local` (the default) uses `UnsafeLocalCodeExecutor`. It runs
 *     the code with the current Node.js binary on this machine with NO
 *     sandbox, and the sample prints a warning. Use it only on a machine where
 *     you would run the model's code yourself.
 *   - `container` uses `ContainerCodeExecutor`. It runs the code with `node`
 *     in a Docker container with the network off. It needs a Docker daemon,
 *     the optional `dockerode` package, and ADK_SAMPLE_CONTAINER_IMAGE set to
 *     an image that has both `node` and `python3` in it, because the executor
 *     checks for `python3` when it starts the container.
 * Any other value of ADK_SAMPLE_CODE_EXECUTOR is an error.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/code_execution/javascript/agent.ts
 *   ADK_SAMPLE_CODE_EXECUTOR=container ADK_SAMPLE_CONTAINER_IMAGE=<image> npm run sample -- samples/code_execution/javascript/agent.ts
 * Try "How many Fridays fall on the 13th of a month between 2000 and 2030?".
 */

import {
  BaseCodeExecutor,
  ContainerCodeExecutor,
  LlmAgent,
  UnsafeLocalCodeExecutor,
} from '@google/adk';

const INSTRUCTION = `
You answer questions by writing JavaScript and running it with Node.js.

- Write the code in a \`\`\`javascript block. Only the first block in a reply runs, and the text after it is dropped.
- Print every result with console.log. The output comes back to you in a \`\`\`tool_output block. NEVER write a \`\`\`tool_output block yourself.
- Use only the Node.js standard library, imported with "import ... from 'node:...'". No npm packages are installed, and you must not install any.
- Nothing carries over between blocks. Declare every value and import that a block needs again.
- If the code fails, read the error, fix the code and run it again.
- When the output answers the question, give the answer and explain in words how the code got it. Do not repeat the code in a \`\`\`javascript block, because every such block runs.
`;

const UNSAFE_LOCAL_WARNING = `
WARNING: ADK_SAMPLE_CODE_EXECUTOR=unsafe_local runs the code that the model
writes with Node.js on this machine, as your user, with your files, your
environment variables and your network. There is no sandbox. Use
ADK_SAMPLE_CODE_EXECUTOR=container to run the code in a Docker container.
`;

function createCodeExecutor(): BaseCodeExecutor {
  const choice = process.env['ADK_SAMPLE_CODE_EXECUTOR'] ?? 'unsafe_local';
  let executor: BaseCodeExecutor;
  switch (choice) {
    case 'unsafe_local':
      process.stderr.write(UNSAFE_LOCAL_WARNING);
      executor = new UnsafeLocalCodeExecutor();
      break;
    case 'container': {
      const image = process.env['ADK_SAMPLE_CONTAINER_IMAGE'];
      if (!image) {
        throw new Error(
          'ADK_SAMPLE_CODE_EXECUTOR=container needs ADK_SAMPLE_CONTAINER_IMAGE, an image with node and python3 in it.',
        );
      }
      executor = new ContainerCodeExecutor({image});
      break;
    }
    default:
      throw new Error(
        `Unknown ADK_SAMPLE_CODE_EXECUTOR "${choice}". Use "unsafe_local" (the default) or "container".`,
      );
  }
  // Match only JavaScript fences. The first pair is also the fence that
  // earlier code is shown in when it goes back into the history.
  executor.codeBlockDelimiters = [
    ['```javascript\n', '\n```'],
    ['```js\n', '\n```'],
  ];
  return executor;
}

export const rootAgent = new LlmAgent({
  name: 'javascript_agent',
  model: 'gemini-flash-latest',
  instruction: INSTRUCTION,
  codeExecutor: createCodeExecutor(),
});
