# CLI and Evaluation Utilities

The CLI utilities in `@google/adk` prepare an agent's environment, state, logging, runner lifecycle, and evaluation datasets when running from the command line, the development server, or an automated test harness. This guide covers `.env` discovery (`walkToRootUntilFound`, `loadDotenvForAgent`), session-to-eval conversion and state initialization (`convertSessionToEvalInvocations`, `convertSessionToEvalFormat`, `createEmptyState`), CLI log routing (`setupAdkLogger`, `logToTmpFolder`), runner cleanup (`closeRunners`), and batch evaluation (`runEvals`, `LocalEvalSetsManager`, `LocalEvalSetResultsManager`, `convertEvalSetToSchema`, `loadEvalSetFromFile`, `getEvaluationCriteriaOrDefault`, `parseAndGetEvalsToRun`).

- `walkToRootUntilFound` and `loadDotenvForAgent` - Locate a `.env` file by walking up from an agent directory to the filesystem root and load its variables into `process.env`.
- `createEmptyState`, `convertSessionToEvalInvocations`, and `convertSessionToEvalFormat` - Initialize `{var}` placeholders referenced in agent instructions and convert recorded `Session` events into structured `EvalInvocation` or `EvaluationItem` turns.
- `setupAdkLogger` and `logToTmpFolder` - Route the global ADK logger to `stderr` or to a timestamped log file in the system temporary folder with a `.latest.log` symlink.
- `closeRunners` - Close multiple `Runner` instances concurrently with a 30-second timeout (`RUNNER_CLEANUP_TIMEOUT_MS`).
- `runEvals`, `LocalEvalSetsManager`, `LocalEvalSetResultsManager`, `convertEvalSetToSchema`, `loadEvalSetFromFile`, `getEvaluationCriteriaOrDefault`, and `parseAndGetEvalsToRun` - Manage local `.evalset.json` datasets (`EvalSet` and `EvalCase`), run multi-turn evaluation cases against an agent, score tool trajectory accuracy and ROUGE-1 response match, and persist `EvalSetResult` records on disk.

## Introduction

An agent run through `adk run`, `adk web`, `adk api_server`, or `adk eval` needs surrounding setup before the first turn starts. Environment variables often live in a `.env` file several directories above the agent file, instruction templates such as `'Answer questions about {topic}'` expect every placeholder key to exist in `session.state`, and interactive sessions captured during development need a way to become repeatable regression tests.

`@google/adk` exports these building blocks directly so your own scripts and test suites can call the same functions the `@google/adk-devtools` CLI uses. Browser-safe helpers (`closeRunners`, `convertSessionToEvalInvocations`, `convertSessionToEvalFormat`, `createEmptyState`, and `isBaseRetrievalTool`) are also available from the `@google/adk` web entrypoint.

## Get started

This example initializes state placeholders with `createEmptyState`, runs one turn of a deterministic agent with `InMemoryRunner`, converts the resulting session into an `EvalCase` with `convertSessionToEvalInvocations`, and scores it with `runEvals`.

```ts
import {
  BaseAgent,
  convertSessionToEvalInvocations,
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
const conversation = convertSessionToEvalInvocations(updatedSession);

for await (const result of runEvals({
  evalCasesByEvalSetId: {
    demo_set: [{evalId: 'status_case', conversation}],
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

When `agentParentFolder` is given, `agentName` must be a single path segment inside it. When it is omitted, `agentName` can be a path, but it must not be `.` or contain a `..` segment. `filename` must be a single path segment. Invalid input throws `InputValidationError` before any file is read. These checks compare strings only and do not follow symlinks.

When deploying to Vertex AI Agent Engine (`adk deploy agent_engine`, `adk deploy agent-engine`, `adk deploy reasoning_engine`, or `adk deploy reasoning-engine`), `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` defined in the agent directory's `.env` file are automatically resolved as the target Google Cloud project and region when `--project` or `--region` flags are omitted. If `--project` or `--region` is explicitly specified on the command line, the explicit CLI option takes precedence.

### ADK service options

The ADK CLI commands (`run`, `web`, `api_server` / `api-server`, `deploy cloud_run` / `deploy cloud-run`, `deploy agent_engine` / `deploy agent-engine`, and `deploy reasoning_engine` / `deploy reasoning-engine`) support configurable backend services via `--session-service-uri` (`--session_service_uri`), `--artifact-service-uri` (`--artifact_service_uri`), and `--memory-service-uri` (`--memory_service_uri`):

- `--session-service-uri, --session_service_uri <string>`: Session service URI. Supported schemes include:
  - `memory://`: In-memory session service (`InMemorySessionService`).
  - `agentengine://<agent_engine>`: Agent Engine sessions (`VertexAiSessionService`), supporting both short resource IDs (`agentengine://123`) with project and region from the environment or `.env`, and full resource names (`agentengine://projects/{project}/locations/{location}/reasoningEngines/{id}`).
- `--artifact-service-uri, --artifact_service_uri <string>`: Artifact service URI (e.g. `gs://<bucket>` for Google Cloud Storage).
- `--memory-service-uri, --memory_service_uri <string>`: Memory service URI. Supported schemes include:
  - `memory://`: In-memory memory service (`InMemoryMemoryService`).
  - `rag://<rag_corpus_id>` or `rag://projects/{project}/locations/{location}/ragCorpora/{id}`: Vertex AI RAG memory service (`VertexAiRagMemoryService`).
  - `agentengine://<agent_engine>`: Agent Engine memory bank (`VertexAiMemoryBankService`), supporting both short resource IDs (`agentengine://123`) with project and region from the environment or `.env`, and full resource names (`agentengine://projects/{project}/locations/{location}/reasoningEngines/{id}`).

### Reloading agents and serving them over A2A

`adk web`, `adk api_server`, and `adk run` accept `--reload-agents, --reload_agents [boolean]` (default `false`). With the option, `adk web` and `adk api_server` watch the agents directory for changes to JavaScript and TypeScript files (`.js`, `.cjs`, `.mjs`, `.ts`, `.mts`, `.cts`) and load the changed agent again on the next request:

- A change to `<agents dir>/<name>.<ext>`, or to a file below `<agents dir>/<name>/`, reloads only the agent `<name>`, when that agent was loaded or failed to load earlier. Several change events for one save still reload only that agent. The other agents keep their compiled bundles.
- A change to any other JavaScript or TypeScript file, such as a new agent or a helper that several agents share, reloads every agent.
- A change to any other file is ignored.

An agent that imports a file from the directory of another agent is not reloaded when that file changes. Keep shared code inside `<agents dir>` outside individual `<agents dir>/<name>/` subdirectories (for example, in `<agents dir>/shared/`), or restart the server. `adk run` with `--reload_agents` watches the one agent file that it runs and uses the new agent for the next turn.

```bash
adk web path/to/agents --reload_agents
```

`adk web` and `adk api_server` accept `--a2a [boolean]` (default `false`). With the option, the server serves each agent that it loaded at startup over the Agent2Agent (A2A) protocol below `/a2a/<appName>`. `--a2a-auth-token, --a2a_auth_token <string>` sets a shared bearer token for these endpoints, and callers must send `Authorization: Bearer <token>`. The `ADK_A2A_AUTH_TOKEN` environment variable sets the same token when the option is absent. Without a token, the server serves the A2A endpoints without authentication.

```bash
export ADK_A2A_AUTH_TOKEN=<token>
adk api_server path/to/agents --a2a
```

`adk deploy cloud_run` accepts the same two options. `--a2a` starts the deployed server with `--a2a`. `--a2a_auth_token` reaches Cloud Run as the `ADK_A2A_AUTH_TOKEN` environment variable and is not written into the image. Without a token, the command prints a security warning, because the deployed A2A endpoints then accept every caller. `adk deploy agent_engine` and `adk deploy reasoning_engine` accept `--a2a`, which also starts the deployed server with `--a2a`. They do not accept `--a2a_auth_token`.

### Session conversion and empty state

`createEmptyState(agent, initializedStates)` walks `agent.subAgents` recursively. For every `LlmAgent` whose `instruction` is a string, it finds `{var}` word placeholders (`/{([\w]+)}/g`) and sets each key to `''`. Keys passed in `initializedStates` are copied on top so caller-supplied values win over the empty defaults.

`convertSessionToEvalInvocations(session)` scans `session.events` in order and groups each `author === 'user'` event that has non-empty `content.parts` with all subsequent non-user events until the next user turn, returning an array of `EvalInvocation` records:

- `userContent` and `invocationId` are copied from the user event. `creationTimestamp` is the user event's `timestamp` converted from milliseconds to seconds, the unit that every `EvalSet`, `EvalCase`, and `EvalInvocation` uses.
- Every `part.functionCall` on subsequent non-user events is appended to `intermediateData.toolUses`.
- Non-empty `part.text` entries on each subsequent event are grouped into `[author, parts]` tuples. All tuples except the last are stored in `intermediateData.intermediateResponses`, and the last tuple's parts become `finalResponse`.

`convertSessionToEvalFormat(session)` (deprecated in favor of `convertSessionToEvalInvocations`) returns legacy `EvaluationItem` records (`{query, expected_tool_use, expected_intermediate_agent_responses, reference}`). It skips user events with missing or empty `parts`, preserves text parts on events that also carry a `functionCall`, and ignores empty-string `''` agent text parts.

### Log routing

`setupAdkLogger(level)` installs a logger via `setLogger` that formats records with an ISO timestamp and level name and writes them to `process.stderr`.

`logToTmpFolder(options)` creates `<os.tmpdir()>/<subFolder>/<logFilePrefix>.<timestamp>.<pid>.log`, routes the global ADK logger to append to that file, and updates `<logFilePrefix>.latest.log` in the same folder as a symbolic link pointing to the newest log file. The default `subFolder` contains the current user name, so users who share a temp folder do not write to the same files. The process ID in the file name keeps two processes that start in the same second apart. The folder is created with mode `0o700` and the log file with mode `0o600`.

### Evaluation runner

`runEvals` accepts either a `RunEvalsOptions` object or positional arguments. Each entry in `evalCasesByEvalSetId` can be an array of `EvalCase` or `EvalEntry` objects, or a list of case IDs to filter from an `.evalset.json` file loaded via `loadEvalSetFromFile`. For each case, it:

1. Calls `resetFunc()` when provided.
2. Creates an isolated session whose id starts with `EVAL_SESSION_ID_PREFIX` (`'___eval___session___'`) and whose state is populated via `createEmptyState`.
3. Runs every user turn in the case through a `Runner` and converts the recorded session with `convertSessionToEvalFormat`.
4. Scores each requested `EvalMetric`:
   - `TOOL_TRAJECTORY_SCORE_KEY` (`'tool_trajectory_avg_score'`): `1.0` for a turn when the actual `expected_tool_use` list matches the expected list in length, `tool_name`, and deep `tool_input`; `0.0` otherwise.
   - `RESPONSE_MATCH_SCORE_KEY` (`'response_match_score'`): unigram ROUGE-1 F1 score between the expected `reference` and the actual `reference`.
5. Yields an `EvalResult` (`EvalCaseResult`) with `eval_set_id`, `session_details`, per-invocation and overall metric results, and sets `final_eval_status` to `EvalStatus.PASSED`, `EvalStatus.FAILED`, or `EvalStatus.NOT_EVALUATED`.

### Managing eval sets, persisting evaluation results, and closing runners

`LocalEvalSetsManager(agentsDir)` manages local `.evalset.json` files under `<agentsDir>/<appName>/<evalSetId>.evalset.json`:

- `createEvalSet(appName, evalSetId)`, `getEvalSet(appName, evalSetId)`, and `listEvalSets(appName)` create, read, and list `EvalSet` datasets. `createEvalSet` throws `InputValidationError` when the eval set already exists. `loadEvalSetFromFile(filePath, evalSetId)` and `convertEvalSetToSchema(evalSetId, json)` read both structured `EvalSet` JSON files and legacy `EvalEntry[]` arrays. A legacy `mock_tool_output` becomes an entry in `intermediateData.toolResponses` that has the same `id` as its tool use, so `runEvals` still stubs that tool call.
- `addEvalCase(appName, evalSetId, evalCase)`, `getEvalCase(appName, evalSetId, evalCaseId)`, `updateEvalCase(appName, evalSetId, updatedEvalCase)`, and `deleteEvalCase(appName, evalSetId, evalCaseId)` perform CRUD operations on individual `EvalCase` records, throwing `NotFoundError` when the target eval set or eval case does not exist and `InputValidationError` when an ID fails `/^[a-zA-Z0-9_]+$/` or path-segment validation.
- `addEvalCase`, `updateEvalCase`, and `deleteEvalCase` write the whole eval set back to disk in the structured `EvalSet` JSON format. A legacy `EvalEntry[]` `.evalset.json` file that you change through these methods is therefore rewritten as an `EvalSet` object, and it is no longer a legacy array.

`LocalEvalSetResultsManager(agentsDir)` persists, loads, and lists `EvalSetResult` records under `<agentsDir>/<appName>/.adk/eval_history/<evalSetResultName>.evalset_result.json`. `saveEvalSetResult({appName, evalSetId, evalCaseResults})` converts case results to camelCase `RunEvalResult` entries, strips internal session metadata with `publicSession`, writes a new record, and returns it; `getEvalSetResult(appName, evalSetResultId)` and `listEvalSetResults(appName)` read records back. It rejects an `appName`, `evalSetId`, or `evalSetResultId` that contains path separators or traversal segments. It writes each record as camelCase JSON (`evalSetResultId`, `evalSetResultName`, `evalSetId`, `evalCaseResults`, `creationTimestamp` in seconds). It reads files with camelCase or snake_case keys, including legacy double-encoded JSON strings.

`LocalEvalSetsManager` implements the `EvalSetsManager` interface and `LocalEvalSetResultsManager` implements the `EvalSetResultsManager` interface. Each interface method can return its value directly or as a promise, so callers `await` every call. The development server (`AdkApiServer`) accepts any implementation through its `evalSetsManager` and `evalSetResultsManager` options, and uses the local managers when you do not set them.

### Storing eval data in Google Cloud Storage

`adk web`, `adk api_server`, and `adk eval` accept `--eval-storage-uri, --eval_storage_uri <string>`. The only supported form is `gs://<bucket name>`. When the URI has a path, such as `gs://my-bucket/some/path`, only the bucket is used. Without the option, the commands keep eval data in the agents directory.

```bash
export GOOGLE_CLOUD_PROJECT=my-project
adk web --eval_storage_uri gs://my-bucket path/to/agents
adk eval path/to/agents/my_app my_eval_set:case_1,case_2 --eval_storage_uri gs://my-bucket
```

With the option, `adk eval` treats its positional arguments as eval set IDs, unless the first one is an existing file. It reads each eval set from the bucket and fails when an ID is not there. It saves the results to the bucket in both cases.

The bucket uses this layout:

| Data            | Blob name                                                            |
| :-------------- | :------------------------------------------------------------------- |
| Eval set        | `<appName>/evals/eval_sets/<evalSetId>.evalset.json`                 |
| Eval set result | `<appName>/evals/eval_history/<evalSetResultId>.evalset_result.json` |

`createGcsEvalManagersFromUri(evalStorageUri, storageOptions?)` builds the two managers that the commands use: a `GcsEvalSetsManager` and a `GcsEvalSetResultsManager`, returned as `GcsEvalManagers`. It takes the project from `storageOptions.projectId`, or else from `GOOGLE_CLOUD_PROJECT`. It throws `InputValidationError` when the URI has another scheme, when no project is set, or when the bucket does not exist. The error messages do not repeat the URI.

```ts
import {createGcsEvalManagersFromUri} from '@google/adk';

const {evalSetsManager, evalSetResultsManager} =
  await createGcsEvalManagersFromUri('gs://my-bucket');
const evalSetIds = await evalSetsManager.listEvalSets('my_app');
const resultIds = await evalSetResultsManager.listEvalSetResults('my_app');
```

The GCS managers implement the same interfaces as the local managers, with async methods. They validate app names and IDs before they call the storage service, and they map a storage 404 response on a list call to `NotFoundError`. They need the optional peer dependency `@google-cloud/storage`. If it is not installed, the first call fails with an error that names the install command, `npm install @google-cloud/storage`.

`closeRunners(runners)` invokes `runner.close()` concurrently across all provided `Runner` instances and waits up to `RUNNER_CLEANUP_TIMEOUT_MS` (`30000` ms), logging a warning if any runner close task does not complete in time.

## Configuration options

### loadDotenvForAgent and walkToRootUntilFound

| Parameter           | Type     | Default  | Description                                                                                    |
| :------------------ | :------- | :------- | :--------------------------------------------------------------------------------------------- |
| `agentName`         | `string` | required | The agent name. A directory or file path is accepted only when `agentParentFolder` is omitted. |
| `agentParentFolder` | `string` | optional | The parent directory used to resolve `agentName`.                                              |
| `filename`          | `string` | `'.env'` | The file name to search for while walking up to the root.                                      |

### LogToTmpFolderOptions

| Option             | Type       | Default               | Description                                                             |
| :----------------- | :--------- | :-------------------- | :---------------------------------------------------------------------- |
| `level`            | `LogLevel` | `LogLevel.INFO`       | Minimum `LogLevel` written to the file.                                 |
| `subFolder`        | `string`   | `'agents_log_<user>'` | Subfolder created inside `os.tmpdir()`.                                 |
| `logFilePrefix`    | `string`   | `'agent'`             | Filename prefix for `<prefix>.<timestamp>.<pid>.log` and `.latest.log`. |
| `logFileTimestamp` | `string`   | `YYYYMMDD_HHMMSS`     | Timestamp segment in the generated log filename.                        |

### RunEvalsOptions

| Option                 | Type                                                       | Default                   | Description                                                                                                                      |
| :--------------------- | :--------------------------------------------------------- | :------------------------ | :------------------------------------------------------------------------------------------------------------------------------- |
| `evalCasesByEvalSetId` | `Record<string, Array<EvalEntry \| EvalCase> \| string[]>` | required                  | Map from evalset identifier or file path to the `EvalCase` or `EvalEntry` cases to run, or to case IDs to select from that file. |
| `rootAgent`            | `BaseAgent`                                                | required                  | The root agent under evaluation.                                                                                                 |
| `resetFunc`            | `() => void \| Promise<void>`                              | `undefined`               | Optional hook invoked before each `EvalEntry`.                                                                                   |
| `evalMetrics`          | `EvalMetric[]`                                             | `DEFAULT_CRITERIA`        | Metrics and thresholds (`tool_trajectory_avg_score: 1.0`, `response_match_score: 0.8`).                                          |
| `printDetailedResults` | `boolean`                                                  | `false`                   | When `true`, prints per-case metric scores to stdout.                                                                            |
| `sessionService`       | `BaseSessionService`                                       | `InMemorySessionService`  | Session service used to store the `___eval___session___` runs.                                                                   |
| `artifactService`      | `BaseArtifactService`                                      | `InMemoryArtifactService` | Artifact service passed to the evaluation `Runner`.                                                                              |

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
- `loadDotenvForAgent`, `logToTmpFolder`, `setupAdkLogger`, `runEvals`, and the GCS eval managers use Node.js filesystem and process modules (`node:fs`, `node:os`, `node:path`) and are exported from the Node `@google/adk` entrypoint, not the browser bundle.
- `getAgentGraph(rootAgent, highlightsPairs, true)` requires the Graphviz `dot` binary to be installed on `PATH` when rendering a PNG buffer.

## Related samples

- [samples/cli/](../../../samples/cli/README.md) - Demonstrates `createEmptyState`, `convertSessionToEvalInvocations`, `parseAndGetEvalsToRun`, `runEvals`, and `LocalEvalSetsManager` offline with a deterministic agent.

## Related guides

- [Sessions](../sessions/index.md) - `Session`, `State`, and `InMemorySessionService` used during evaluation runs.
- [BaseRetrievalTool](../tools/retrieval/base_retrieval_tool/index.md) - The retrieval tool base class identified by `isBaseRetrievalTool`.
