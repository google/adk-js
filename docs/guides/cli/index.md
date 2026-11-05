# CLI and Evaluation Utilities

The CLI utilities in `@google/adk` prepare an agent's environment, state, logging, and evaluation datasets when running from the command line, the development server, or an automated test harness. This guide covers `.env` discovery (`walkToRootUntilFound`, `loadDotenvForAgent`), session-to-eval conversion and state initialization (`convertSessionToEvalFormat`, `createEmptyState`), CLI log routing (`setupAdkLogger`, `logToTmpFolder`), and batch evaluation (`runEvals`, `getEvaluationCriteriaOrDefault`, `parseAndGetEvalsToRun`).

- `walkToRootUntilFound` and `loadDotenvForAgent` - Locate a `.env` file by walking up from an agent directory to the filesystem root and load its variables into `process.env`.
- `createEmptyState` and `convertSessionToEvalFormat` - Initialize `{var}` placeholders referenced in agent instructions and convert recorded `Session` events into `EvaluationItem` turns.
- `setupAdkLogger` and `logToTmpFolder` - Route the global ADK logger to `stderr` or to a timestamped log file in the system temporary folder with a `.latest.log` symlink.
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

`setupAdkLogger(level)` installs a logger via `setLogger` that formats records with an ISO timestamp and level name and writes them to `process.stderr`.

`logToTmpFolder(options)` creates `<os.tmpdir()>/<subFolder>/<logFilePrefix>.<timestamp>.log`, routes the global ADK logger to append to that file, and updates `<logFilePrefix>.latest.log` in the same folder as a symbolic link pointing to the newest log file.

### Evaluation runner

`runEvals` accepts either a `RunEvalsOptions` object or positional arguments. For each `EvalEntry` in `evalCasesByEvalSetId`, it:

1. Calls `resetFunc()` when provided.
2. Creates an isolated session whose id starts with `EVAL_SESSION_ID_PREFIX` (`'___eval___session___'`) and whose state is populated via `createEmptyState`.
3. Runs every user turn in `evalCase.data` through a `Runner` and converts the recorded session with `convertSessionToEvalFormat`.
4. Scores each requested `EvalMetric`:
   - `TOOL_TRAJECTORY_SCORE_KEY` (`'tool_trajectory_avg_score'`): `1.0` for a turn when the actual `expected_tool_use` list matches the expected list in length, `tool_name`, and deep `tool_input`; `0.0` otherwise.
   - `RESPONSE_MATCH_SCORE_KEY` (`'response_match_score'`): unigram ROUGE-1 F1 score between the expected `reference` and the actual `reference`.
   - The metrics in [Vertex AI evaluation metrics](#vertex-ai-evaluation-metrics): the turns are sent to the Vertex AI evaluation service.
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
| `evalClient`           | `VertexAiEvaluationClient`    | created on first use      | Client for the Vertex AI metrics. Defaults to a `v1beta1.EvaluationServiceClient`.      |

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

### Vertex AI evaluation metrics

The Vertex AI evaluation service scores some metrics, not ADK. Select them like any other metric: in the `criteria` of the `test_config.json` file that `adk eval` reads, or in `evalMetrics` for `runEvals`.

| Metric key                         | Constant                               | Vertex AI metric spec              | What it judges                                                 |
| :--------------------------------- | :------------------------------------- | :--------------------------------- | :------------------------------------------------------------- |
| `safety_v1`                        | `SAFETY_V1_KEY`                        | `safety_v1`                        | Harmlessness of each final response. 1.0 is safe.              |
| `multi_turn_task_success_v1`       | `MULTI_TURN_TASK_SUCCESS_V1_KEY`       | `multi_turn_task_success_v1`       | Whether the agent achieved the goal of the whole conversation. |
| `multi_turn_trajectory_quality_v1` | `MULTI_TURN_TRAJECTORY_QUALITY_V1_KEY` | `multi_turn_trajectory_quality_v1` | The path that the agent took through the conversation.         |
| `multi_turn_tool_use_quality_v1`   | `MULTI_TURN_TOOL_USE_QUALITY_V1_KEY`   | `multi_turn_tool_use_quality_v1`   | How well the agent used its tools in the conversation.         |

```json
{
  "criteria": {
    "safety_v1": 1.0,
    "multi_turn_task_success_v1": 0.8
  }
}
```

These metrics need a Google Cloud project, a location, and Google Cloud credentials. Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, for example in the agent's `.env` file. When you select a Vertex AI metric and either value is missing, `runEvals` throws before it runs a case.

Single-turn metrics send one request per turn and average the valid scores. Multi-turn metrics send the whole conversation as one request, with the instructions and tool declarations of every agent in the tree. The score goes on the last turn, and the earlier turns are `EvalStatus.NOT_EVALUATED`. When Vertex AI returns rubric verdicts, an explanation, or an error, `runEvals` puts them in `rubric_scores` on the metric result. A missing or `NaN` score makes the metric `EvalStatus.NOT_EVALUATED`.

To call the metrics from your own code, use the facades. `SingleTurnVertexAiEvalFacade` and `MultiTurnVertexAiEvalFacade` take a threshold, a Vertex AI metric spec name, an optional project and location, and an optional `client`. Their `evaluateInvocations` method takes `Invocation` objects and returns an `EvaluationResult`:

```ts
import {MultiTurnVertexAiEvalFacade} from '@google/adk';

const facade = new MultiTurnVertexAiEvalFacade({
  threshold: 0.8,
  metricName: 'multi_turn_task_success_v1',
  projectId: 'my-project',
  location: 'us-central1',
});
const result = await facade.evaluateInvocations(invocations);
console.log(result.overallScore, result.overallRubricScores);
```

Multi-turn metrics send the `agents` map from the `appDetails` of the invocations. `buildAppDetailsFromAgent(rootAgent)` builds it from an agent tree, and `runEvals` attaches it for you. An invocation without `appDetails` adds no agents; the request is still sent. Each turn holds the user message, the steps in `InvocationEvents` (the form `runEvals` records), and one agent event with the final response. The steps in an `IntermediateData` object (the form that eval set turns use) are not sent.

### Identifying retrieval tools in custom graph renderers

`BaseRetrievalTool` instances carry a cross-bundle symbol brand checked by `isBaseRetrievalTool(obj)`. The development server's agent graph renderer uses `isBaseRetrievalTool` to label retrieval tools with `🔎` and draw them with a `'cylinder'` shape instead of the `'box'` shape used for regular function tools.

## Limitations

- `createEmptyState` only inspects `LlmAgent` instances whose `instruction` is a static `string`. Placeholders inside an `InstructionProvider` function are not extracted statically.
- `loadDotenvForAgent`, `logToTmpFolder`, `setupAdkLogger`, and `runEvals` use Node.js filesystem and process modules (`node:fs`, `node:os`, `node:path`) and are exported from the Node `@google/adk` entrypoint, not the browser bundle.
- The Vertex AI facades load `@google-cloud/aiplatform` on first use. They are exported from the Node `@google/adk` entrypoint only. The evaluation types (`Invocation`, `EvaluationResult`, `RubricScore`, `AppDetails`) and `Evaluator` are also in the browser bundle.
- `response_evaluation_score` stays an offline ROUGE-1 score, as before. It is not sent to the Vertex AI coherence metric.
- There is no conversation scenario generator. The Node.js `@google-cloud/aiplatform` client has no RPC that generates conversation scenarios.
- `getAgentGraph(rootAgent, highlightsPairs, true)` requires the Graphviz `dot` binary to be installed on `PATH` when rendering a PNG buffer.

## Related samples

- [samples/cli/](../../../samples/cli/README.md) - Demonstrates `createEmptyState`, `convertSessionToEvalFormat`, `parseAndGetEvalsToRun`, and `runEvals` offline with a deterministic agent.

## Related guides

- [Sessions](../sessions/index.md) - `Session`, `State`, and `InMemorySessionService` used during evaluation runs.
- [BaseRetrievalTool](../tools/retrieval/base_retrieval_tool/index.md) - The retrieval tool base class identified by `isBaseRetrievalTool`.
