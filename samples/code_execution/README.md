# Code Execution Sample (`BuiltInCodeExecutor`, `UnsafeLocalCodeExecutor`, and `ContainerCodeExecutor`)

This sample demonstrates how the `codeExecutor` option on `LlmAgent` lets an agent answer by writing Python and running it, either server-side in Gemini with `BuiltInCodeExecutor` or client-side with `UnsafeLocalCodeExecutor` or `ContainerCodeExecutor`.

## Overview

`data_science_agent` is an `LlmAgent` with a code executor. The instruction is ported from the adk-python `code_execution` sample: it tells the model to inspect data before it analyzes it, to print every result in a ` ```tool_code ` block, and to parse any data in the prompt into a pandas DataFrame.

`ADK_SAMPLE_CODE_EXECUTOR` selects the executor:

| Value                | Executor                  | Where the code runs                        |
| :------------------- | :------------------------ | :----------------------------------------- |
| `built_in` (default) | `BuiltInCodeExecutor`     | Gemini, server-side. Nothing runs locally. |
| `unsafe_local`       | `UnsafeLocalCodeExecutor` | A `python3` subprocess on this machine.    |
| `container`          | `ContainerCodeExecutor`   | A Docker container with the network off.   |

With `built_in`, the executor adds the `codeExecution` tool to each request, and the model writes the code, runs it, and reads the output in one response. With a client-side executor, ADK finds the first ` ```tool_code ` or ` ```python ` block in the model response, runs it, and sends the output back to the model in a ` ```tool_output ` block. The model then writes the next step or the answer. The instruction asks for Python only, so the sample sets `codeBlockDelimiters` to those two fences, and a JavaScript or shell block in a reply stays text. Any other value of `ADK_SAMPLE_CODE_EXECUTOR` stops the sample with an error.

With `built_in`, the ` ```tool_code ` fences in the instruction are only examples of format. Nothing runs a ` ```tool_code ` block that the model writes as text. If the model prints code instead of running it, ask it to run the code.

> [!WARNING]
> `unsafe_local` runs the code that the model writes on your machine, as your user, with your files, your environment variables and your network. There is no sandbox. Use it only on a machine where you would run that code yourself. The sample and the executor both print a warning when it runs.

The sample pins `gemini-2.5-flash` rather than the `gemini-flash-latest` alias the other samples use. `BuiltInCodeExecutor` reads the Gemini version from the model name and throws for any name it cannot parse as version 2 or later, and that includes the alias.

To have the model write JavaScript and run it with Node.js instead, see the [JavaScript code execution sample](./javascript/README.md).

## Sample Inputs

- `What is the standard deviation of 3, 7, 7, 19 and 24?`

  _The model writes and runs a short computation, reads its printed output, and answers with the value._

- `Is 2147483647 a prime number?`

  _The model writes a primality check rather than answering from memory._

- `Here are monthly sales: Jan 120, Feb 135, Mar 90, Apr 160. Which month had the largest change from the month before, and by how much?`

  _Data in the prompt. The instruction tells the model to parse all of it into a pandas DataFrame, so a client-side executor needs pandas where the code runs._

## Running the Sample

The sample calls a live model, so set `GEMINI_API_KEY` first.

Run the exported `rootAgent` interactively through the ADK CLI after building the workspace. The default uses `BuiltInCodeExecutor` and needs nothing else:

```bash
npm run build
npm run sample -- samples/code_execution/agent.ts
```

To run the code on this machine, you need `python3` on `PATH`, with pandas installed for the DataFrame prompt:

```bash
ADK_SAMPLE_CODE_EXECUTOR=unsafe_local npm run sample -- samples/code_execution/agent.ts
```

To run the code in Docker, you need a running Docker daemon and the optional `dockerode` package. The executor does not pull images, so pull or build the image first. `ADK_SAMPLE_CONTAINER_IMAGE` selects it, and the default `python:3.12-slim` has no pandas. The container has no network, so the code cannot install packages:

```bash
npm install dockerode
docker pull python:3.12-slim
ADK_SAMPLE_CODE_EXECUTOR=container npm run sample -- samples/code_execution/agent.ts
```

To try another model, change `model` in `agent.ts`. `built_in` needs a versioned Gemini 2 or later model name, such as `gemini-2.5-pro`.

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Code executors](../../docs/guides/code_executors/index.md) - Choosing between server-side and client-side execution, `BaseCodeExecutor`, `BuiltInCodeExecutor`, `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, `AgentEngineSandboxCodeExecutor`, and writing your own executor.
