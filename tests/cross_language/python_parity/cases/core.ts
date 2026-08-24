/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const CORE_CASES: ParityCase[] = [
  {
    id: 'core_hello_world',
    family: 'core',
    pySample: 'core/hello_world',
    tsAgent: 'core/hello_world',
    queries: ['Roll a die with 6 sides, then check if the result is prime.'],
    // The roll is random on both sides, so the stored rolls never match.
    volatileStateKeys: ['rolls'],
  },
  {
    id: 'core_quickstart',
    family: 'core',
    pySample: 'core/quickstart',
    tsAgent: 'core/quickstart',
    // The README's sample inputs, minus "what time is it in New York" — that
    // one returns a wall clock reading, which cannot agree across two runs.
    // Tokyo exercises `get_current_time` on its deterministic error path.
    queries: [
      'What is the weather in New York?',
      'Can you tell me the weather in Tokyo?',
      'What time is it in Tokyo?',
    ],
  },
  {
    id: 'core_empty_agent',
    family: 'core',
    pySample: 'core/empty_agent',
    tsAgent: 'core/empty_agent',
    queries: ['go'],
    note:
      'A bare agent with no instruction and no tools: the case measures the' +
      ' framework-supplied system instruction and request defaults, so the' +
      ' two replies are expected to differ in wording.',
  },
  {
    id: 'core_abort',
    family: 'core',
    pySample: 'core/abort',
    tsAgent: 'core/abort',
    queries: ['Count to 10 seconds'],
    note:
      'The sample exists to show cooperative cancellation on client' +
      ' disconnect, which a replayed run never triggers; the happy path is' +
      ' what is compared. Python cancels via asyncio.CancelledError out of' +
      ' `await asyncio.sleep`, adk-js via `toolContext.abortSignal`.',
  },
  {
    id: 'core_callbacks',
    family: 'core',
    pySample: 'core/callbacks',
    tsAgent: 'core/callbacks',
    queries: [
      'What is the weather in Paris?',
      'What is the weather in London?',
      'Hi',
    ],
    note:
      'The after_model callback appends live token counts to every model' +
      ' reply, so the text carries the two runtimes\u2019 prompt sizes and' +
      ' will not match verbatim \u2014 the interesting part is whether both' +
      ' short-circuits (before_tool for London, before_model for "Hi") fire.',
  },
  {
    id: 'core_artifacts',
    family: 'core',
    pySample: 'core/artifacts',
    tsAgent: 'core/artifacts',
    queries: [
      'Generate a text report about AI agents',
      'Generate a dummy image artifact',
      'Load the latest version of the image artifact',
    ],
    note:
      "The sample's `video` branch encodes an MP4 with opencv-python; the TS" +
      ' port reports that instead of writing a file, so the queries stay on' +
      ' the text and image branches. Everything else (save_artifact,' +
      ' versioning, LoadArtifactsTool) has a direct adk-js equivalent.',
  },
  {
    id: 'core_input_output_schema',
    family: 'core',
    pySample: 'core/input_output_schema',
    tsAgent: 'core/input_output_schema',
    queries: [
      'What is the weather in San Jose?',
      'Can you check the weather for Cupertino?',
    ],
    note:
      "adk-js does not auto-wrap a sub-agent as a tool: Python's LlmAgent" +
      ' appends a `_SingleTurnAgentTool` for every sub_agent whose `mode` is' +
      " 'single_turn'/'task' (and drops it from the transfer targets), while" +
      ' adk-js `mode` only selects workflow-node behaviour. The TS port' +
      ' therefore states the `AgentTool` explicitly, and the sub-agent run is' +
      ' expected to show up differently: Python emits the sub-agent turn into' +
      ' the same session on a branch, adk-js `AgentTool` runs it through a' +
      ' nested Runner under its own app name.',
  },
  {
    id: 'core_app',
    family: 'core',
    pySample: 'core/app',
    tsAgent: 'core/app',
    queries: ['Hello, who are you?', 'Can you help me plan a trip?'],
    note:
      'adk-js `AppOptions` is only {name, rootAgent, plugins,' +
      ' resumabilityConfig}: there is no `eventsCompactionConfig` (compaction' +
      ' in adk-js is per-agent via `LlmAgent.contextCompactors`), no' +
      ' `contextCacheConfig` at all, and no `SaveFilesAsArtifactsPlugin`.' +
      ' With compaction_interval=2 the Python run compacts after the second' +
      ' turn and the TS run does not, so an extra Python event is expected.',
  },
  {
    id: 'core_logprobs',
    family: 'core',
    pySample: 'core/logprobs',
    queries: [
      'What is the capital of France?',
      'What are the philosophical implications of artificial consciousness?',
    ],
    skip: 'unsupported-in-ts',
    note:
      'adk-js `LlmResponse` (core/src/models/llm_response.ts) has no' +
      ' `avgLogprobs` and no `logprobsResult` field, and `createLlmResponse()`' +
      ' copies only content/groundingMetadata/citationMetadata/usageMetadata/' +
      'finishReason off the candidate — `candidate.avgLogprobs` and' +
      ' `candidate.logprobsResult` are dropped. The request side works' +
      ' (`generateContentConfig.responseLogprobs`/`logprobs` are plain genai' +
      ' fields), so the model returns logprobs and the framework discards' +
      ' them before any afterModelCallback can read them.',
  },
  {
    id: 'core_runner_debug_example',
    family: 'core',
    pySample: 'core/runner_debug_example',
    tsAgent: 'core/runner_debug_example',
    // The message sequence from the sample's own main.py.
    queries: [
      "What's the weather in Tokyo?",
      'How about New York?',
      "What's the stock price of GOOGL?",
    ],
    note:
      'The Python sample is a tour of `Runner.run_debug()`, a debug-only' +
      ' convenience wrapper with no adk-js equivalent (adk-js `Runner`' +
      ' exposes `runAsync`/`runEphemeral`/`runLive` and nothing that batches' +
      ' messages, prints them, or defaults a session id). The agent itself' +
      ' ports unchanged, so that is what the case compares.',
  },
];
