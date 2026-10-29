# CLI and Evaluation Utilities Sample (`createEmptyState`, `convertSessionToEvalFormat`, and `runEvals`)

This sample demonstrates how the CLI evaluation utilities prepare state placeholders from an agent tree, convert a recorded `Session` into an evaluation dataset, and run trajectory and response-match evaluations offline.

## Overview

`OrderSupportAgent` is a deterministic `BaseAgent` subclass that calls no model. It holds a child `LlmAgent` whose instruction references `{department}` and `{locale}` placeholders. On each turn:

- A query containing `'order'` emits a `lookup_order` `functionCall` event, its `functionResponse` event, and the final text `'Order ORD-100 has shipped.'`.
- Any other query replies with the active `locale` from `ctx.session.state`.

The `main()` driver calls `createEmptyState(rootAgent, {locale: 'en-GB'})` to populate `{department: '', locale: 'en-GB'}`, runs two turns through `InMemoryRunner`, converts the stored session into `EvaluationItem` records with `convertSessionToEvalFormat`, parses an evalset selector with `parseAndGetEvalsToRun`, scores the agent with `runEvals`, persists and reloads the `EvalSetResult` with `LocalEvalSetResultsManager`, and cleans up the runner with `closeRunners`.

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

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [CLI and Evaluation Utilities](../../docs/guides/cli/index.md) - `loadDotenvForAgent`, `walkToRootUntilFound`, `createEmptyState`, `convertSessionToEvalFormat`, `setupAdkLogger`, `logToTmpFolder`, `closeRunners`, `LocalEvalSetResultsManager`, and `runEvals`.
