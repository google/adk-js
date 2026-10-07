# Code executors (`BaseCodeExecutor`, `BuiltInCodeExecutor`, `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, and `AgentEngineSandboxCodeExecutor`)

A code executor lets an `LlmAgent` answer by writing code and running it. This
guide covers the executors in `core/src/code_executors/`, the two ways they run
code, the processors that connect them to the model, and how to write your own.

## Introduction

Some questions are easier to answer with a program than with prose: arithmetic
on large numbers, statistics over a table, or a check that a date falls on a
weekday. A model that writes and runs code for these questions gets exact
results, because the interpreter computes them and the model reads the output.

You give an agent a code executor through the `codeExecutor` field of
`LlmAgent`. Every executor extends `BaseCodeExecutor`, and there are two kinds:

- **Server-side execution.** `BuiltInCodeExecutor` asks Gemini to run the code
  with its own code execution tool. The code runs on Google's side, inside the
  model call, and nothing runs in your process.
- **Client-side execution.** `UnsafeLocalCodeExecutor`,
  `ContainerCodeExecutor` and `AgentEngineSandboxCodeExecutor` run code that
  ADK extracts from the model response. The code runs where the executor sends
  it: a local subprocess, a Docker container or a managed cloud sandbox.

| Executor                         | Where the code runs              | What it needs                                               | Isolation                         |
| :------------------------------- | :------------------------------- | :---------------------------------------------------------- | :-------------------------------- |
| `BuiltInCodeExecutor`            | Gemini, server-side              | A versioned Gemini 2 or later model name                    | Managed by Gemini                 |
| `UnsafeLocalCodeExecutor`        | A subprocess on your host        | `python3` on `PATH`, `python` on Windows                    | None                              |
| `ContainerCodeExecutor`          | A Docker container               | A Docker daemon, the optional `dockerode` package, an image | Container, network off by default |
| `AgentEngineSandboxCodeExecutor` | A Vertex AI Agent Engine sandbox | A Google Cloud project, and a location or `us-central1`     | Managed remote sandbox            |

### Choosing between server-side and client-side execution

Choose server-side execution when a Gemini model is acceptable and you do not
need control over the runtime. `BuiltInCodeExecutor` needs no interpreter, no
container and no cloud resource, and the model writes, runs and reads the code
within one call. In exchange, Gemini decides what the runtime contains, and ADK
receives no files from it.

Choose client-side execution when you need to control the runtime: the
packages in it, the network access, the files it can read, or the model that
writes the code. ADK then runs each code block the model writes, sends the
output back, and calls the model again, so a client-side run takes at least
two model calls. The runtime is also yours to secure: read the isolation column
in the table above before you choose an executor.

## Get started

This agent uses Gemini's built-in code execution. The model name must carry a
Gemini version of 2 or later, for the reason in
[BuiltInCodeExecutor](#builtincodeexecutor).

```ts
import {BuiltInCodeExecutor, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'calculator_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer numeric questions by writing and running Python. Print every result.',
  codeExecutor: new BuiltInCodeExecutor(),
});
```

Ask it "What is 2 to the power of 100?". When the model runs code, its response
carries an `executableCode` part with the code and a `codeExecutionResult` part
with the printed output, beside the text of the answer.

## How it works

ADK connects an executor to the model through two processors, and both are in
the default `LlmAgent` pipeline. The request processor runs before every model
call, and the response processor runs after every model call. Both do nothing
for an agent without a `codeExecutor`.

### BuiltInCodeExecutor

`BuiltInCodeExecutor` is the only executor that does its work in the request
processor. Before each model call it adds the `codeExecution` tool to the
request, and Gemini decides when to call it. Its `executeCode` method returns an
empty result, and the response processor skips it, because ADK never runs the
code itself.

The executor reads the model name and throws
`Gemini code execution tool is not supported for model <name>` unless it finds
a Gemini version of 2 or later. It parses the version from the text after
`gemini-`, so `gemini-2.5-flash` works and an alias such as
`gemini-flash-latest` fails.

The code runs in Google's environment as part of the model call, not on your
machine.

### UnsafeLocalCodeExecutor

`UnsafeLocalCodeExecutor` writes the code to a script in a new temporary
directory and runs it as a subprocess of your process. Python runs with
`python3`, or `python` on Windows. The executor also runs JavaScript with the
current Node.js binary and shell scripts with `bash`, PowerShell or `cmd.exe`.
It returns `Unsupported language` as stderr for TypeScript.

The executor copies input files into the temporary directory, and it returns
every other file the script writes there as an output file. It kills a run that
takes longer than `timeoutSeconds`, 30 by default, and reports the timeout as
stderr.

The executor gives no isolation. The script runs as your user, with your
environment, your network and your file system, and the executor logs a
warning on every run to say so. Use it only for code you would run yourself.

````ts
import {LlmAgent, UnsafeLocalCodeExecutor} from '@google/adk';

export const localAgent = new LlmAgent({
  name: 'local_python_agent',
  model: 'gemini-flash-latest',
  instruction: 'Write Python in a ```python block to answer.',
  codeExecutor: new UnsafeLocalCodeExecutor({timeoutSeconds: 10}),
});
````

### ContainerCodeExecutor

`ContainerCodeExecutor` runs each code string in one long-lived Docker
container that it starts on first use. It needs a reachable Docker daemon and
the `dockerode` package, which is an optional dependency of `@google/adk`.
Install it with `npm install dockerode`. You must set `image`, a tag to run, or
`dockerPath`, a directory with a Dockerfile to build. The constructor throws
when neither is set. After the container starts, the executor checks that
`python3` is in the image.

The container starts with networking off, so the code cannot reach the cloud
metadata endpoint, internal services or the internet. Set
`networkEnabled: true` only for code you trust. Each run is killed after
`timeoutSeconds`, 300 by default, because every run shares one container and a
runaway loop would slow every later run.

The executor runs a code string only. It does not copy input files into the
container and it returns no output files. Call `close()` to stop and remove the
container when your application shuts down.

````ts
import {ContainerCodeExecutor, LlmAgent} from '@google/adk';

const containerExecutor = new ContainerCodeExecutor({
  image: 'python:3.12-slim',
  timeoutSeconds: 60,
});

export const containerAgent = new LlmAgent({
  name: 'container_python_agent',
  model: 'gemini-flash-latest',
  instruction: 'Write Python in a ```python block to answer.',
  codeExecutor: containerExecutor,
});

export async function shutdown(): Promise<void> {
  await containerExecutor.close();
}
````

### AgentEngineSandboxCodeExecutor

`AgentEngineSandboxCodeExecutor` sends the code to a Vertex AI Agent Engine code
execution sandbox. It needs a Google Cloud project, from `projectId` or the
`GOOGLE_CLOUD_PROJECT` environment variable, and it throws
`Project ID is required.` when there is none. The location comes from
`location`, then `GOOGLE_CLOUD_LOCATION`, then `us-central1`.

You can point it at an existing sandbox with `sandboxResourceName`, or at an
Agent Engine with `agentEngineResourceName`. The project and location in a
resource name override the other settings. With neither, the executor creates
an Agent Engine on first use. When there is no fixed sandbox, it creates one
per language and stores its name in session state under
`sandbox_name_<language>`, so later runs in the same session reuse it.

The sandbox supports Python and JavaScript, and it returns files the code
writes as output files. The code runs in Google Cloud, not on your machine.
Input file content must already be base64 encoded.

````ts
import {AgentEngineSandboxCodeExecutor, LlmAgent} from '@google/adk';

export const sandboxAgent = new LlmAgent({
  name: 'sandbox_python_agent',
  model: 'gemini-flash-latest',
  instruction: 'Write Python in a ```python block to answer.',
  codeExecutor: new AgentEngineSandboxCodeExecutor({
    agentEngineResourceName:
      'projects/my-project/locations/us-central1/reasoningEngines/123',
  }),
});
````

### What the request processor does

The request processor runs before every model call for an agent that has a
code executor. For `BuiltInCodeExecutor` it adds the `codeExecution` tool. For
a client-side executor with `optimizeDataFile` set, it prepares data files. For
every executor, it then rewrites earlier code and results in the history.

Only `text/csv` inline data in user messages counts as a data file. The
processor replaces each such part with the text
``Available file: `data_<i>_<j>.csv` ``, where `<i>` and `<j>` are the
positions of the message and the part, so the file bytes never reach the model.
It keeps the file in session state, and for each file it has not seen before it
runs a helper that loads the CSV with pandas and prints its shape, column
types, null counts and unique values. The helper code and its output go into
the request, so the model sees a summary of the data before it writes code.
Later runs receive every saved file as an input file.

The history rewrite turns code and results into plain text. A model message
whose last part is `executableCode` gets that part replaced by the code wrapped
in the first entry of `codeBlockDelimiters`. A message with a single
`codeExecutionResult` part becomes a user message with the output wrapped in
`executionResultDelimiters`. The model therefore sees its earlier code and the
output as ordinary text in the formats it is told to use.

### What the response processor does

The response processor runs after each complete model response. For a
client-side executor it finds the first code block in the response and runs
it. If you pass your own `responseProcessors` to `LlmAgent`, the list replaces
the defaults. Add a `CodeExecutionResponseProcessor` to that list to keep
client-side execution.

```ts
import {
  CodeExecutionResponseProcessor,
  LlmAgent,
  UnsafeLocalCodeExecutor,
} from '@google/adk';

export const customAgent = new LlmAgent({
  name: 'custom_processors_agent',
  model: 'gemini-flash-latest',
  codeExecutor: new UnsafeLocalCodeExecutor(),
  responseProcessors: [new CodeExecutionResponseProcessor()],
});
```

It looks for an `executableCode` part first. When there is none, it joins the
text parts and searches them for a block that starts with any leading
delimiter in `codeBlockDelimiters` and ends with any trailing delimiter. It
keeps the text before the block, drops everything after it, and emits the
response with the code as an event.

The tag of the fence that matched sets the language that the processor passes
to the executor in `CodeExecutionInput.language`:

| Fence tag                   | Language                            |
| :-------------------------- | :---------------------------------- |
| `tool_code`, `python`, `py` | `CodeExecutionLanguage.PYTHON`      |
| `javascript`, `js`          | `CodeExecutionLanguage.JAVASCRIPT`  |
| `typescript`, `ts`          | `CodeExecutionLanguage.TYPESCRIPT`  |
| `bash`, `sh`, `shell`       | `CodeExecutionLanguage.SHELL`       |
| Any other tag, or no fence  | `CodeExecutionLanguage.UNSPECIFIED` |

An `executableCode` part is always Python. The match ignores case. ADK does not
guess the language of a custom delimiter that is not in the table, so give a
custom delimiter one of these fence tags. Each executor runs the languages it
supports and handles the others in its own way, as the
[Limitations](#limitations) section explains.

It then runs the code and emits a second event with one `codeExecutionResult`
part. On failure the outcome is `OUTCOME_FAILED` and the output is stderr. On
success the outcome is `OUTCOME_OK` and the output is
`Code execution result:\n<stdout>\n`, followed by `Saved artifacts:\n` and the
file names, each in backticks and separated by commas, when the code wrote
files. Each output file is saved through the artifact service, and its version
goes in the event's `artifactDelta`. The processor throws
`Artifact service is not initialized.` when the runner has no artifact service,
so give your `Runner` one. `InMemoryRunner` and `npm run sample` already do.
Last, the processor removes the original model response, so the agent calls
the model again with the result in the history.

### Error retries

`errorRetryAttempts`, 2 by default, limits consecutive failed runs within one
invocation. A run with stderr adds one to the count for the current invocation,
and a run without stderr resets it. When the count reaches the limit, both
processors stop running code for the rest of the invocation, and the model's
next response is returned as it is. The count lives in session state, keyed by
invocation, so a new user message starts from zero.

### Stateful execution

When an executor has `stateful` set, the processors pass an `executionId` in
each `CodeExecutionInput`. The id is the session id, stored in session state
the first time it is needed. It gives an executor a key to keep interpreter
state, such as variables and imports, between runs in one session.

None of the executors in `@google/adk` reads `executionId`. The field is there
for a custom executor. `ContainerCodeExecutor` fixes `stateful` and
`optimizeDataFile` at `false` and throws in strict mode if you assign either.
`UnsafeLocalCodeExecutor` sets both to `false` but lets you assign them.
Setting `optimizeDataFile` on it turns on the data-file step, and setting
`stateful` changes nothing, because it does not read `executionId`.

## Configuration options

Every executor inherits these fields from `BaseCodeExecutor`. They are public
fields, not constructor options, so you set them on the instance.

| Option                      | Type                      | Default                                                         | Description                                                       |
| :-------------------------- | :------------------------ | :-------------------------------------------------------------- | :---------------------------------------------------------------- |
| `optimizeDataFile`          | `boolean`                 | `false`                                                         | Turns CSV inline data into files and summarizes each new one.     |
| `stateful`                  | `boolean`                 | `false`                                                         | Passes the session id as `executionId`.                           |
| `errorRetryAttempts`        | `number`                  | `2`                                                             | Consecutive failed runs allowed in one invocation.                |
| `codeBlockDelimiters`       | `Array<[string, string]>` | `tool_code`, `python`, `javascript`, `typescript`, `bash`, `sh` | Fences that mark a code block. The first renders code in history. |
| `executionResultDelimiters` | `[string, string]`        | ` ```tool_output\n ` and ` \n``` `                              | Fence around a result in history.                                 |

`codeBlockDelimiters` has two jobs, so its order matters. Every pair is used to
find code in a response, and only the first pair is used to write code back
into the history. Put the fence you tell the model to use first, so that the
history shows the model the format you asked for. The default puts
` ```tool_code\n ` first, which matches the instruction style of the
adk-python samples. To limit the languages that run, keep only the fences for
those languages.

`executionResultDelimiters` wraps each result in the history. Tell the model in
the instruction that results arrive in this fence and that it must not write
the fence itself.

The executors add their own constructor options.

| Executor                         | Option                    | Default                                      | Description                               |
| :------------------------------- | :------------------------ | :------------------------------------------- | :---------------------------------------- |
| `UnsafeLocalCodeExecutor`        | `timeoutSeconds`          | `30`                                         | Kills a run after this many seconds.      |
| `UnsafeLocalCodeExecutor`        | `pythonCommandPath`       | `python3`, `python` on Windows               | The Python interpreter to run.            |
| `UnsafeLocalCodeExecutor`        | `commandPath`             | The current Node.js binary                   | The JavaScript runtime.                   |
| `UnsafeLocalCodeExecutor`        | `shellCommandPath`        | `bash`, `powershell` on Windows              | The shell for shell scripts.              |
| `ContainerCodeExecutor`          | `image`                   | `adk-code-executor:latest` with `dockerPath` | The image tag to run.                     |
| `ContainerCodeExecutor`          | `dockerPath`              | None                                         | A directory with a Dockerfile to build.   |
| `ContainerCodeExecutor`          | `baseUrl`                 | The local Docker socket                      | The Docker daemon to use.                 |
| `ContainerCodeExecutor`          | `networkEnabled`          | `false`                                      | Gives the container network access.       |
| `ContainerCodeExecutor`          | `timeoutSeconds`          | `300`                                        | Kills a run after this many seconds.      |
| `AgentEngineSandboxCodeExecutor` | `sandboxResourceName`     | None                                         | An existing sandbox to use.               |
| `AgentEngineSandboxCodeExecutor` | `agentEngineResourceName` | None, and one is created                     | The Agent Engine that owns new sandboxes. |
| `AgentEngineSandboxCodeExecutor` | `projectId`               | `GOOGLE_CLOUD_PROJECT`                       | The Google Cloud project.                 |
| `AgentEngineSandboxCodeExecutor` | `location`                | `GOOGLE_CLOUD_LOCATION`, then `us-central1`  | The Google Cloud region.                  |

This example tells the model to use Python fences and gives it one retry.

````ts
import {LlmAgent, UnsafeLocalCodeExecutor} from '@google/adk';

const executor = new UnsafeLocalCodeExecutor();
executor.codeBlockDelimiters = [['```python\n', '\n```']];
executor.errorRetryAttempts = 1;

export const retryAgent = new LlmAgent({
  name: 'python_fence_agent',
  model: 'gemini-flash-latest',
  instruction:
    'Write Python in a ```python block. Results arrive in a ```tool_output block.',
  codeExecutor: executor,
});
````

## Advanced applications

### Writing a custom BaseCodeExecutor

Write your own executor when none of the shipped ones runs code where you need
it, for example on a service your team already operates. Extend
`BaseCodeExecutor` and implement `executeCode`. It receives the invocation
context and a `CodeExecutionInput`, and it returns a `CodeExecutionResult`.

Return a non-empty `stderr` for any failure, including a non-zero exit with no
error output. The processors treat an empty `stderr` as success, so a failure
without stderr never reaches the retry logic. Mark each output file with its
`contentEncoding`: a `FileContentEncoding.UTF8` file is base64 encoded before
it is saved as an artifact, and any other content is saved as it is, so it must
already be base64.

This executor sends Python to an HTTP service and maps the reply to a result.

```ts
import {
  BaseCodeExecutor,
  CodeExecutionLanguage,
  CodeExecutionResult,
  ExecuteCodeParams,
  File,
  FileContentEncoding,
} from '@google/adk';

interface RunReply {
  stdout: string;
  stderr: string;
  files: Array<{name: string; text: string}>;
}

export class HttpCodeExecutor extends BaseCodeExecutor {
  constructor(private readonly endpoint: string) {
    super();
    this.stateful = true;
  }

  override async executeCode({
    codeExecutionInput,
  }: ExecuteCodeParams): Promise<CodeExecutionResult> {
    if (codeExecutionInput.language !== CodeExecutionLanguage.PYTHON) {
      return {
        stdout: '',
        stderr: `Unsupported language: ${codeExecutionInput.language}`,
        outputFiles: [],
      };
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        code: codeExecutionInput.code,
        sessionId: codeExecutionInput.executionId,
        files: codeExecutionInput.inputFiles,
      }),
    });
    if (!response.ok) {
      return {
        stdout: '',
        stderr: `Execution service returned ${response.status}`,
        outputFiles: [],
      };
    }

    const reply = (await response.json()) as RunReply;
    const outputFiles: File[] = reply.files.map((file) => ({
      name: file.name,
      content: file.text,
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    }));
    return {stdout: reply.stdout, stderr: reply.stderr, outputFiles};
  }
}
```

The executor sets `stateful`, so `executionId` carries the session id and the
service can keep one interpreter per session. Each `File` in `inputFiles` has a
`name`, a `content` and a `mimeType`, and the service writes them where the
code can open them by name.

## Limitations

Code execution in this release has these limits.

- **Each executor runs only some languages.** The default `codeBlockDelimiters`
  match `javascript`, `typescript`, `bash` and `sh` fences as well as Python
  ones, and the processors pass the language of the fence to the executor. A
  fence with an unknown tag gives `CodeExecutionLanguage.UNSPECIFIED`.
  `UnsafeLocalCodeExecutor` returns stderr for TypeScript and for an
  unspecified language. `ContainerCodeExecutor` throws for an unspecified
  language, which ends the invocation, and its TypeScript command needs `tsx`
  in the image. `AgentEngineSandboxCodeExecutor` supports Python and JavaScript
  only, and it throws for any other language, which ends the invocation. Set
  `codeBlockDelimiters` to the fences of the languages your executor runs.
- **Code in the history is shown in the first fence.** When ADK writes earlier
  code back into the history, it uses the first pair in `codeBlockDelimiters`
  whatever the language was, so with the defaults a `bash` block reappears as a
  `tool_code` block.
- **A custom `requestProcessors` list drops the code execution request
  processor.** It is not exported from `@google/adk`, so a list that you pass
  to `LlmAgent` cannot include it. Without it, `BuiltInCodeExecutor` adds no
  tool, and earlier code and results stay as parts in the history. Leave
  `requestProcessors` unset on an agent with a code executor.
- **The data-file summary fails outside Vertex AI.** The helper that summarizes
  a CSV calls a `crop` function that none of the executors in `@google/adk`
  defines, so it fails with a `NameError` and counts as a failed run. adk-python
  0.1.0 has the same defect: only its Vertex AI executor defines `crop`.
- **`BuiltInCodeExecutor` rejects model aliases.** It needs a Gemini version
  in the model name, so `gemini-flash-latest` and other `-latest` aliases throw.
  Use a versioned name such as `gemini-2.5-flash`.
- **There is no Vertex AI Code Interpreter executor.** adk-python has a
  `VertexAiCodeExecutor` that calls the Vertex AI Code Interpreter extension.
  Neither `@google-cloud/vertexai` nor `@google/genai` has a client for Vertex
  AI Extensions, and the service is a deprecated Preview offering. Use
  `AgentEngineSandboxCodeExecutor` to run code in a managed Google Cloud
  sandbox instead.
- **`ContainerCodeExecutor` does not move files.** It copies no input files
  into the container and returns no output files.

## Related samples

- [Code execution](../../../samples/code_execution/README.md) - A data science agent that answers with `BuiltInCodeExecutor` by default, or with `UnsafeLocalCodeExecutor` or `ContainerCodeExecutor`.
- [JavaScript code execution](../../../samples/code_execution/javascript/README.md) - An agent that writes JavaScript and runs it with Node.js through `UnsafeLocalCodeExecutor` or `ContainerCodeExecutor`, with `codeBlockDelimiters` limited to the JavaScript fences.

## Related guides

- [ADK developer guides](../README.md) - The index of every guide in this repository.
