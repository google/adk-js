# CLI and Evaluation Utilities Sample (`createEmptyState`, `convertSessionToEvalInvocations`, and `runEvals`)

This sample demonstrates how the CLI evaluation utilities prepare state placeholders from an agent tree, convert a recorded `Session` into an evaluation dataset, and run trajectory and response-match evaluations offline.

## Overview

`OrderSupportAgent` is a deterministic `BaseAgent` subclass that calls no model. It holds a child `LlmAgent` whose instruction references `{department}` and `{locale}` placeholders. On each turn:

- A query containing `'order'` emits a `lookup_order` `functionCall` event, its `functionResponse` event, and the final text `'Order ORD-100 has shipped.'`.
- Any other query replies with the active `locale` from `ctx.session.state`.

The `main()` driver calls `createEmptyState(rootAgent, {locale: 'en-GB'})` to populate `{department: '', locale: 'en-GB'}`, runs two turns through `InMemoryRunner`, converts the stored session into `EvalInvocation` records with `convertSessionToEvalInvocations`, wraps them in an `EvalCase`, parses an evalset selector with `parseAndGetEvalsToRun`, scores the agent against that `EvalCase` with `runEvals`, exercises `LocalEvalSetsManager` case CRUD (`createEvalSet`, `addEvalCase`, `getEvalCase`, `updateEvalCase`, `deleteEvalCase`), persists and reloads the `EvalSetResult` with `LocalEvalSetResultsManager`, and cleans up the runner with `closeRunners`.

## Sample Inputs

- `Check my order status`

  _Emits a `lookup_order` tool call and responds with `Order ORD-100 has shipped.`._

- `Thank you`

  _Responds with `[en-GB] Received: Thank you`._

## Running the Sample

The sample needs nothing beyond the workspace build: no API key and no external service.

Run the self-contained script directly to see state initialization, session-to-eval conversion, and evaluation scores:

```bash
npx tsx samples/cli/agent.ts
```

Or run the exported `rootAgent` interactively through the ADK CLI after building the workspace:

```bash
npm run build
npm run sample -- samples/cli/agent.ts
```

To use the browser UI instead, serve the file with `adk web`:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/cli/agent.ts
```

Add `--reload_agents` to pick up edits to `agent.ts` without a server restart. The server loads the changed agent again on the next request:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/cli/agent.ts --reload_agents
```

Add `--a2a` to also serve the agent over the Agent2Agent (A2A) protocol below `/a2a/agent`, and `--a2a_auth_token` to require a bearer token on those endpoints:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/cli/agent.ts --a2a --a2a_auth_token <token>
```

To keep eval sets and eval results in a Google Cloud Storage bucket instead of the agents directory, add `--eval_storage_uri`. The bucket must exist, `GOOGLE_CLOUD_PROJECT` must name its project, and the optional peer `@google-cloud/storage` must be installed:

```bash
npm install @google-cloud/storage
export GOOGLE_CLOUD_PROJECT=<your project>
node dev/dist/esm/cli_entrypoint.js web samples/cli/agent.ts --eval_storage_uri gs://<bucket name>
```

The UI then saves eval sets to `<appName>/evals/eval_sets/` and eval results to `<appName>/evals/eval_history/` in the bucket.

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [CLI and Evaluation Utilities](../../docs/guides/cli/index.md) - `loadDotenvForAgent`, `walkToRootUntilFound`, `createEmptyState`, `convertSessionToEvalInvocations`, `setupAdkLogger`, `logToTmpFolder`, `closeRunners`, `LocalEvalSetsManager`, `LocalEvalSetResultsManager`, `createGcsEvalManagersFromUri`, and `runEvals`.
