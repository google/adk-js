/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code execution
 * ../../docs/guides/code_executors/index.md
 *
 * A data science agent that answers by writing Python and running it.
 *
 * By default the agent uses `BuiltInCodeExecutor`, so the model runs the code
 * server-side with Gemini's code execution tool. Nothing runs on your
 * machine, and the code and its output come back as parts of the model
 * response.
 *
 * Set ADK_SAMPLE_CODE_EXECUTOR to run the code client-side instead. ADK then
 * finds the first ```tool_code or ```python block in the model response, runs
 * it, and sends the output back to the model in a ```tool_output block. The
 * instruction asks for Python only, so the sample sets `codeBlockDelimiters`
 * to the Python fences, and a JavaScript or shell block in a reply stays text:
 *   - `unsafe_local` uses `UnsafeLocalCodeExecutor`. It runs the code as a
 *     python3 subprocess on this machine with NO sandbox, and the sample
 *     prints a warning when you select it. Use it only on a machine where you
 *     would run the model's code yourself.
 *   - `container` uses `ContainerCodeExecutor`. It runs the code in a Docker
 *     container with the network off. It needs a Docker daemon and the
 *     optional `dockerode` package. ADK_SAMPLE_CONTAINER_IMAGE sets the image,
 *     `python:3.12-slim` by default.
 * Any other value of ADK_SAMPLE_CODE_EXECUTOR is an error.
 *
 * The model is pinned to `gemini-2.5-flash` rather than the floating
 * `gemini-flash-latest` alias the other samples use. `BuiltInCodeExecutor`
 * accepts only a model name with a Gemini version of 2 or higher in it, and
 * it throws `Gemini code execution tool is not supported for model
 * gemini-flash-latest` for the alias.
 *
 * The instruction is ported verbatim from the main branch of adk-python's
 * `contributing/samples/code_execution/code_execution` sample. That text tells
 * the model that variables and imports do not persist between snippets, which
 * is right here, because none of these executors keeps interpreter state
 * between runs. The literal
 * `{{x=}}` and `{{variable=}}` stay as written: they are not valid state
 * names, so instruction templating leaves them in place.
 *
 * With `built_in`, the ```tool_code and ```tool_output fences in the
 * instruction are only examples of format. Gemini runs code through its own
 * tool, and nothing runs a ```tool_code block that the model writes as text.
 * If the model prints code instead of running it, ask it to run the code.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/code_execution/agent.ts
 *   ADK_SAMPLE_CODE_EXECUTOR=unsafe_local npm run sample -- samples/code_execution/agent.ts
 *   ADK_SAMPLE_CODE_EXECUTOR=container npm run sample -- samples/code_execution/agent.ts
 * Try "What is the standard deviation of 3, 7, 7, 19 and 24?".
 */

import {
  BaseCodeExecutor,
  BuiltInCodeExecutor,
  ContainerCodeExecutor,
  LlmAgent,
  UnsafeLocalCodeExecutor,
} from '@google/adk';

const BASE_SYSTEM_INSTRUCTION = `
  # Guidelines

  **Objective:** Assist the user in achieving their data analysis goals within the context of a Python Colab notebook, **with emphasis on avoiding assumptions and ensuring accuracy.** Reaching that goal can involve multiple steps. When you need to generate code, you **don't** need to solve the goal in one go. Only generate the next step at a time.

  **Code Execution:** All code snippets provided will be executed within the Colab environment.

  **Statefulness:** Variables and imports do NOT carry over between turns. Re-create any variable, re-load any file and re-import any library that a snippet needs.

  **Imported Libraries:** Nothing is imported for you. Import what you need (for example \`io\`, \`math\`, \`re\`, \`matplotlib.pyplot as plt\`, \`numpy as np\`, \`pandas as pd\`, \`scipy\`) at the top of every snippet that uses it.

  **Output Visibility:** Always print the output of code execution to visualize results, especially for data exploration and analysis. For example:
    - To look at the shape of a pandas.DataFrame do:
      \`\`\`tool_code
      print(df.shape)
      \`\`\`
      The output will be presented to you as:
      \`\`\`tool_output
      (49, 7)

      \`\`\`
    - To display the result of a numerical computation:
      \`\`\`tool_code
      x = 10 ** 9 - 12 ** 5
      print(f'{{x=}}')
      \`\`\`
      The output will be presented to you as:
      \`\`\`tool_output
      x=999751168

      \`\`\`
    - You **never** generate \`\`\`tool_output yourself.
    - You can then use this output to decide on next steps.
    - Print just variables (e.g., \`print(f'{{variable=}}')\`.

  **No Assumptions:** **Crucially, avoid making assumptions about the nature of the data or column names.** Base findings solely on the data itself. Always inspect the data (its shape, dtypes and column names) before analyzing it.

  **Available files:** Only use the files that are available as specified in the list of available files.

  **Data in prompt:** Some queries contain the input data directly in the prompt. You have to parse that data into a pandas DataFrame. ALWAYS parse all the data. NEVER edit the data that are given to you.

  **Answerability:** Some queries may not be answerable with the available data. In those cases, inform the user why you cannot process their query and suggest what type of data would be needed to fulfill their request.

  `;

const INSTRUCTION =
  BASE_SYSTEM_INSTRUCTION +
  `


You need to assist the user with their queries by looking at the data and the context in the conversation.
You final answer should summarize the code and code execution relevant to the user query.

You should include all pieces of data to answer the user query, such as the table from code execution results.
If you cannot answer the question directly, you should follow the guidelines above to generate the next step.
If the question can be answered directly with writing any code, you should do that.
If you doesn't have enough data to answer the question, you should ask for clarification from the user.

You should NEVER install any package on your own like \`pip install ...\`.
When plotting trends, you should make sure to sort and order the data by the x-axis.


`;

const UNSAFE_LOCAL_WARNING = `
WARNING: ADK_SAMPLE_CODE_EXECUTOR=unsafe_local runs the code that the model
writes as a python3 subprocess on this machine, as your user, with your files,
your environment variables and your network. There is no sandbox. Use
ADK_SAMPLE_CODE_EXECUTOR=container to run the code in a Docker container.
`;

/**
 * Limits a client-side executor to the Python fences. The default
 * `codeBlockDelimiters` also match JavaScript, TypeScript and shell fences.
 */
function withPythonFences(executor: BaseCodeExecutor): BaseCodeExecutor {
  executor.codeBlockDelimiters = [
    ['```tool_code\n', '\n```'],
    ['```python\n', '\n```'],
  ];
  return executor;
}

function createCodeExecutor(): BaseCodeExecutor {
  const choice = process.env['ADK_SAMPLE_CODE_EXECUTOR'] ?? 'built_in';
  switch (choice) {
    case 'built_in':
      return new BuiltInCodeExecutor();
    case 'unsafe_local':
      process.stderr.write(UNSAFE_LOCAL_WARNING);
      return withPythonFences(new UnsafeLocalCodeExecutor());
    case 'container':
      return withPythonFences(
        new ContainerCodeExecutor({
          image:
            process.env['ADK_SAMPLE_CONTAINER_IMAGE'] ?? 'python:3.12-slim',
        }),
      );
    default:
      throw new Error(
        `Unknown ADK_SAMPLE_CODE_EXECUTOR "${choice}". Use "built_in" (the default), "unsafe_local" or "container".`,
      );
  }
}

export const rootAgent = new LlmAgent({
  name: 'data_science_agent',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  codeExecutor: createCodeExecutor(),
});
