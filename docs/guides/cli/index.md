# CLI and Evaluation Utilities

The CLI utilities in `@google/adk` prepare an agent's environment, state, logging, and evaluation datasets when running from the command line, the development server, or an automated test harness. This guide covers `.env` discovery (`walkToRootUntilFound`, `loadDotenvForAgent`), session-to-eval conversion and state initialization (`convertSessionToEvalFormat`, `createEmptyState`), CLI log routing (`setupAdkLogger`, `logToStderr`, `logToTmpFolder`), and batch evaluation (`runEvals`, `getEvaluationCriteriaOrDefault`, `parseAndGetEvalsToRun`).

- `walkToRootUntilFound` and `loadDotenvForAgent` - Locate a `.env` file by walking up from an agent directory to the filesystem root and load its variables into `process.env`.
- `createEmptyState` and `convertSessionToEvalFormat` - Initialize `{var}` placeholders referenced in agent instructions and convert recorded `Session` events into `EvaluationItem` turns.
- `setupAdkLogger`, `logToStderr`, and `logToTmpFolder` - Route the global ADK logger to `stderr` or to a timestamped log file in the system temporary folder with a `.latest.log` symlink.
- `runEvals`, `getEvaluationCriteriaOrDefault`, and `parseAndGetEvalsToRun` - Run multi-turn evaluation cases against an agent and score tool trajectory accuracy and ROUGE-1 response match.

## Introduction

An agent run through `adk run`, `adk web`, `adk api_server`, or `adk eval` needs surrounding setup before the first turn starts. Environment variables often live in a `.env` file several directories above the agent file, instruction templates such as `'Answer questions about {topic}'` expect every placeholder key to exist in `session.state`, and interactive sessions captured during development need a way to become repeatable regression tests.

`@google/adk` exports these building blocks directly so your own scripts and test suites can call the same functions the `@google/adk-devtools` CLI uses. Browser-safe helpers (`convertSessionToEvalFormat`, `createEmptyState`, and `isBaseRetrievalTool`) are also available from the `@google/adk` web entrypoint.

## Get started

This example initializes state placeholders with `createEmptyState`, runs one turn of a deterministic agent with `InMemoryRunner`, converts the resulting session into an evaluation case with `convertSessionToEvalFormat`, and scores it with `runEvals`.

```ts
import {
  BaseAgent,
  convertSessionToEvalFormat,
  createEmptyState,
  createEvent,
  EvalStatus,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  runEvals,
} from '@google/adk';

class EchoEvalAgent extends BaseAgent {
  constructor() {
    super({
      name: 'echo_eval_agent',
      subAgents: [
        new LlmAgent({
          name: 'template_helper',
          model: 'gemini-flash-latest',
          instruction: 'Use tone {tone} for topic {topic}.',
        }),
      ],
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const query =
      ctx.userContent?.parts?.map((part) => part.text ?? '').join('') ?? '';
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `Handled: ${query}`}]},
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

const agent = new EchoEvalAgent();
const initialState = createEmptyState(agent, {tone: 'concise'});
// {tone: 'concise', topic: ''}

const runner = new InMemoryRunner({agent, appName: 'cli_demo'});
const session = await runner.sessionService.createSession({
  appName: 'cli_demo',
  userId: 'user-1',
  state: initialState,
});

for await (const _event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'check status'}]},
})) {
  // Consume events.
}

const updatedSession = await runner.sessionService.getSession({
  appName: 'cli_demo',
  userId: 'user-1',
  sessionId: session.id,
});
const evalItems = convertSessionToEvalFormat(updatedSession);

for await (const result of runEvals({
  evalCasesByEvalSetId: {
    demo_set: [{name: 'status_case', data: evalItems}],
  },
  rootAgent: agent,
})) {
  process.stdout.write(
    `${result.eval_id}: ${EvalStatus[result.final_eval_status]}\n`,
  );
}
```

## How it works

Each helper handles one stage of preparing, observing, or evaluating an agent run.

### Environment loading

`walkToRootUntilFound(folder, filename)` checks `path.join(folder, filename)`. When that path exists and is a regular file, it returns the resolved absolute path; otherwise it moves to `path.dirname(folder)` and repeats until it reaches the filesystem root, where it returns `''`.

`loadDotenvForAgent(agentName, agentParentFolder, filename)` resolves the starting directory from `agentParentFolder` and `agentName`, walks up with `walkToRootUntilFound`, and parses the first `.env` file it finds. Existing keys in `process.env` are overwritten so that switching between agents in the same process updates the active configuration.

### Session conversion and empty state

`createEmptyState(agent, initializedStates)` walks `agent.subAgents` recursively. For every `LlmAgent` whose `instruction` is a string, it finds `{var}` word placeholders (`/{([\w]+)}/g`) and sets each key to `''`. Keys passed in `initializedStates` are copied on top so caller-supplied values win over the empty defaults.

`convertSessionToEvalFormat(session)` scans `session.events` in order and groups each `author === 'user'` event with all subsequent non-user events until the next user turn:

- Every `part.functionCall` is appended to `expected_tool_use` as `{tool_name, tool_input}`.
- Events that contain neither `functionCall` nor `functionResponse` parts are collected as `[author, parts]` tuples in `expected_intermediate_agent_responses`.
- The last non-tool agent response is popped from `expected_intermediate_agent_responses` and its text parts are joined to form `reference`.

### Log routing

`setupAdkLogger(level)` and `logToStderr(level)` install a logger via `setLogger` that formats records with an ISO timestamp and level name and writes them to `process.stderr`.

`logToTmpFolder(options)` creates `<os.tmpdir()>/<subFolder>/<logFilePrefix>.<timestamp>.log`, routes the global ADK logger to append to that file, and updates `<logFilePrefix>.latest.log` in the same folder as a symbolic link pointing to the newest log file.

### Evaluation runner

`runEvals` accepts either a `RunEvalsOptions` object or positional arguments. For each `EvalEntry` in `evalCasesByEvalSetId`, it:

1. Calls `resetFunc()` when provided.
2. Creates an isolated session whose id starts with `EVAL_SESSION_ID_PREFIX` (`'___eval___session___'`) and whose state is populated via `createEmptyState`.
3. Runs every user turn in `evalCase.data` through a `Runner` and converts the recorded session with `convertSessionToEvalFormat`.
4. Scores each requested `EvalMetric`:
   - `TOOL_TRAJECTORY_SCORE_KEY` (`'tool_trajectory_avg_score'`): `1.0` for a turn when the actual `expected_tool_use` list matches the expected list in length, `tool_name`, and deep `tool_input`; `0.0` otherwise.
   - `RESPONSE_MATCH_SCORE_KEY` (`'response_match_score'`): unigram ROUGE-1 F1 score between the expected `reference` and the actual `reference`.
5. Yields an `EvalResult` with per-invocation and overall metric results and sets `final_eval_status` to `EvalStatus.PASSED`, `EvalStatus.FAILED`, or `EvalStatus.NOT_EVALUATED`.

## Configuration options

### loadDotenvForAgent and walkToRootUntilFound

| Parameter           | Type     | Default  | Description                                               |
| :------------------ | :------- | :------- | :-------------------------------------------------------- |
| `agentName`         | `string` | required | The agent name, directory, or file path.                  |
| `agentParentFolder` | `string` | `'.'`    | The parent directory used to resolve `agentName`.         |
| `filename`          | `string` | `'.env'` | The file name to search for while walking up to the root. |

### LogToTmpFolderOptions

| Option             | Type       | Default           | Description                                                       |
| :----------------- | :--------- | :---------------- | :---------------------------------------------------------------- |
| `level`            | `LogLevel` | `LogLevel.INFO`   | Minimum `LogLevel` written to the file.                           |
| `subFolder`        | `string`   | `'agents_log'`    | Subfolder created inside `os.tmpdir()`.                           |
| `logFilePrefix`    | `string`   | `'agent'`         | Filename prefix for `<prefix>.<timestamp>.log` and `.latest.log`. |
| `logFileTimestamp` | `string`   | `YYYYMMDD_HHMMSS` | Timestamp segment in the generated log filename.                  |

### RunEvalsOptions

| Option                 | Type                          | Default                   | Description                                                                             |
| :--------------------- | :---------------------------- | :------------------------ | :-------------------------------------------------------------------------------------- |
| `evalCasesByEvalSetId` | `Record<string, EvalEntry[]>` | required                  | Map from evalset identifier or file path to the `EvalEntry` cases to run.               |
| `rootAgent`            | `BaseAgent`                   | required                  | The root agent under evaluation.                                                        |
| `resetFunc`            | `() => void \| Promise<void>` | `undefined`               | Optional hook invoked before each `EvalEntry`.                                          |
| `evalMetrics`          | `EvalMetric[]`                | `DEFAULT_CRITERIA`        | Metrics and thresholds (`tool_trajectory_avg_score: 1.0`, `response_match_score: 0.8`). |
| `printDetailedResults` | `boolean`                     | `false`                   | When `true`, prints per-case metric scores to stdout.                                   |
| `sessionService`       | `BaseSessionService`          | `InMemorySessionService`  | Session service used to store the `___eval___session___` runs.                          |
| `artifactService`      | `BaseArtifactService`         | `InMemoryArtifactService` | Artifact service passed to the evaluation `Runner`.                                     |

## Advanced applications

### Filtering eval cases from CLI arguments

`parseAndGetEvalsToRun(evalSetFilePaths)` splits CLI specifications of the form `'path/to/set.evalset.json:case_1,case_2'` into a map from file path to requested case names. An entry without a colon maps to an empty array `[]`, indicating that all cases in the file should run.

```ts
import {parseAndGetEvalsToRun} from '@google/adk';

const mapping = parseAndGetEvalsToRun([
  'weather.evalset.json:sunny_day,rainy_day',
  'billing.evalset.json',
]);
// {
//   'weather.evalset.json': ['sunny_day', 'rainy_day'],
//   'billing.evalset.json': [],
// }
```

### Identifying retrieval tools in custom graph renderers

`BaseRetrievalTool` instances carry a cross-bundle symbol brand checked by `isBaseRetrievalTool(obj)`. The development server's agent graph renderer uses `isBaseRetrievalTool` to label retrieval tools with `🔎` and draw them with a `'cylinder'` shape instead of the `'box'` shape used for regular function tools.

## Limitations

- `createEmptyState` only inspects `LlmAgent` instances whose `instruction` is a static `string`. Placeholders inside an `InstructionProvider` function are not extracted statically.
- `loadDotenvForAgent`, `logToTmpFolder`, `logToStderr`, and `runEvals` use Node.js filesystem and process modules (`node:fs`, `node:os`, `node:path`) and are exported from the Node `@google/adk` entrypoint, not the browser bundle.
- `getAgentGraph(rootAgent, highlightsPairs, true)` requires the Graphviz `dot` binary to be installed on `PATH` when rendering a PNG buffer.

## Related samples

- [samples/cli/](../../../samples/cli/README.md) - Demonstrates `createEmptyState`, `convertSessionToEvalFormat`, `parseAndGetEvalsToRun`, and `runEvals` offline with a deterministic agent.

## Related guides

- [Sessions](../sessions/index.md) - `Session`, `State`, and `InMemorySessionService` used during evaluation runs.
- [BaseRetrievalTool](../tools/retrieval/base_retrieval_tool/index.md) - The retrieval tool base class identified by `isBaseRetrievalTool`.
