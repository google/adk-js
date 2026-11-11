# JavaScript Code Execution Sample (`UnsafeLocalCodeExecutor` and `ContainerCodeExecutor`)

This sample demonstrates how an `LlmAgent` answers by writing JavaScript and running it client-side with Node.js, through `UnsafeLocalCodeExecutor` or `ContainerCodeExecutor`.

## Overview

`javascript_agent` is an `LlmAgent` with a built-in client-side code executor. The instruction tells the model to write a ` ```javascript ` block, to print every result with `console.log`, and to use only the Node.js standard library.

After each model response, ADK finds the first ` ```javascript ` or ` ```js ` block, passes it to the executor as `CodeExecutionLanguage.JAVASCRIPT`, and sends the output back to the model in a ` ```tool_output ` block. The model then writes the next step or the answer. A runtime error goes back the same way, so the model can fix the code. After two failed runs in a row, ADK stops running code for that message.

Both executors run JavaScript as they are, so the sample needs no custom executor. It only sets `codeBlockDelimiters` to the JavaScript fences, so that a Python or shell block in a reply stays text. `ADK_SAMPLE_CODE_EXECUTOR` selects the executor:

| Value                    | Executor                  | Where the code runs                                |
| :----------------------- | :------------------------ | :------------------------------------------------- |
| `unsafe_local` (default) | `UnsafeLocalCodeExecutor` | The current Node.js binary on this machine.        |
| `container`              | `ContainerCodeExecutor`   | `node` in a Docker container with the network off. |

Any other value of `ADK_SAMPLE_CODE_EXECUTOR` stops the sample with an error.

> [!WARNING]
> `unsafe_local` runs the code that the model writes on your machine, as your user, with your files, your environment variables and your network. There is no sandbox. Use it only on a machine where you would run that code yourself. The sample and the executor both print a warning when it runs.

The [Python sample](../README.md) in the parent directory shows the same loop with Python, and Gemini's server-side code execution.

## Sample Inputs

- `How many Fridays fall on the 13th of a month between 2000 and 2030?`

  _The model loops over the months with `Date`, prints the count, and answers with it._

- `What is the SHA-256 hash of the string "adk"?`

  _The model imports `createHash` from `node:crypto` and prints the digest rather than answering from memory._

- `Sort these words by length, then alphabetically: pear, fig, banana, kiwi, apple.`

  _Data in the prompt. The model declares an array, sorts it with a comparator, and prints the result._

## Running the Sample

The sample calls a live model, so set `GEMINI_API_KEY` first.

Run the exported `rootAgent` interactively through the ADK CLI after building the workspace. The default runs the code with the current Node.js binary and needs nothing else:

```bash
npm run build
npm run sample -- samples/code_execution/javascript/agent.ts
```

To run the code in Docker, you need a running Docker daemon and the optional `dockerode` package. Set `ADK_SAMPLE_CONTAINER_IMAGE` to an image that has both `node` and `python3`, because `ContainerCodeExecutor` checks for `python3` when it starts the container. The executor does not pull images, so pull or build the image first. The container has no network, so the code cannot install packages:

```bash
npm install dockerode
ADK_SAMPLE_CODE_EXECUTOR=container ADK_SAMPLE_CONTAINER_IMAGE=<image> npm run sample -- samples/code_execution/javascript/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Code executors](../../../docs/guides/code_executors/index.md) - Choosing between server-side and client-side execution, `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, and the fence-to-language mapping.
