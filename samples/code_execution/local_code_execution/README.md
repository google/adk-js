# Local Code Execution Sample (`UnsafeLocalCodeExecutor`)

This sample demonstrates how to attach `UnsafeLocalCodeExecutor` to an `LlmAgent` so the agent writes Python code blocks, executes them locally in a `python3` subprocess, and reads the printed output before answering.

## Overview

`local_code_execution_agent` is an `LlmAgent` configured with `UnsafeLocalCodeExecutor` and `codeBlockDelimiters` restricted to ` ```python ` and ` ```tool_code ` fences. When the model responds with a Python code block, ADK extracts the code, runs it in a temporary directory on the host machine, and sends the stdout or stderr back to the model in a ` ```tool_output ` block.

> [!WARNING]
> `UnsafeLocalCodeExecutor` runs model-generated code on your machine as your user without a sandbox. Use it only in trusted local development environments.

## Graph

```
[local_code_execution_agent (LlmAgent)] ---> [UnsafeLocalCodeExecutor (python3)]
```

## How To

1. Instantiate `UnsafeLocalCodeExecutor` and restrict `codeBlockDelimiters` to the Python fences the agent instruction asks for:

   ````ts
   const codeExecutor = new UnsafeLocalCodeExecutor({timeoutSeconds: 30});
   codeExecutor.codeBlockDelimiters = [
     ['```python\n', '\n```'],
     ['```tool_code\n', '\n```'],
   ];
   ````

2. Pass the executor to `LlmAgent` via `codeExecutor` and export the agent as `rootAgent`:

   ```ts
   export const rootAgent = new LlmAgent({
     name: 'local_code_execution_agent',
     model: 'gemini-flash-latest',
     instruction: '...',
     codeExecutor,
   });
   ```

## Sample Inputs

- `Calculate the first 15 Fibonacci numbers and their sum.`

  _The model writes a short Python loop, prints both the sequence and its sum, and summarizes the result._

- `What is the greatest common divisor of 309120 and 458640?`

  _The model imports `math.gcd`, prints the exact divisor, and reports the answer._

## Running the Sample

Set `GEMINI_API_KEY` and ensure `python3` is available on `PATH`, then build and run the sample through the ADK CLI:

```bash
npm run build
npm run sample -- samples/code_execution/local_code_execution/agent.ts
```

`samples/` is not an npm workspace, so type-check it separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Code executors](../../../docs/guides/code_executors/index.md) - Choosing between server-side and client-side execution, `BaseCodeExecutor`, `BuiltInCodeExecutor`, `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, `VertexAiCodeExecutor`, and `AgentEngineSandboxCodeExecutor`.
