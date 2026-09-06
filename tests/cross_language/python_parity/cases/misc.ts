/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const MISC_CASES: ParityCase[] = [
  {
    id: 'codeexec_code_execution',
    family: 'code_execution',
    pySample: 'code_execution/code_execution',
    tsAgent: 'code_execution/code_execution',
    // The instruction's own worked example, then a "data in the prompt" turn,
    // which is the branch the guidelines spend the most words on. Both have a
    // single correct answer, so the code the model writes may differ but the
    // printed result must not.
    queries: [
      'What is 10 ** 9 - 12 ** 5?',
      'Here is my data:\nname,score\nalice,90\nbob,72\ncarol,85\nWhat is the mean score, and who is above it?',
    ],
    note:
      '`BuiltInCodeExecutor` exists in both runtimes and does the same thing' +
      ' \u2014 append `{codeExecution: {}}` to the request tools for Gemini 2+' +
      ' and let the model run the code server-side \u2014 so this compares how' +
      ' each runtime surfaces executableCode / codeExecutionResult parts in' +
      ' the event stream. adk-js is missing two of the four Python code' +
      ' executors: it has `BuiltInCodeExecutor`,' +
      ' `UnsafeLocalCodeExecutor` and `AgentEngineSandboxCodeExecutor`, but' +
      ' no `ContainerCodeExecutor`, no `VertexAiCodeExecutor` and no' +
      ' `GkeCodeExecutor` (the last is what the sample\u2019s sibling' +
      ' gke_sandbox_agent.py uses).',
  },
  {
    id: 'multimodal_static_non_text_content',
    family: 'multimodal',
    pySample: 'multimodal/static_non_text_content',
    // The default test prompts from the sample's main.py.
    queries: [
      'What reference materials do you have access to?',
      'Can you describe the sample chart that was provided to you?',
      'What does the contributing guide document say about best practices?',
    ],
    skip: 'unsupported-in-ts',
    note:
      'Same missing API as context_static_instruction, plus the part of it' +
      ' that is specific to non-text content. adk-js `LlmAgent` has no' +
      ' `staticInstruction` field at all, so there is nowhere to put a' +
      ' `Content` whose parts are `inlineData` blobs and `fileData` URIs,' +
      ' and nothing in `@google/adk` implements the reference-ID rewriting' +
      ' the sample exists to demonstrate (Python replaces each non-text part' +
      ' with `[Reference to inline binary data: inline_data_0' +
      " ('sample_chart.png', type: image/png)]` in the system instruction" +
      ' and moves the bytes into user contents \u2014 `grep -rn' +
      ' "Reference to inline binary data" core/src` is empty). The sample' +
      ' also uploads a document to the Gemini Files API at import time,' +
      ' which needs live credentials, and adk-js exposes no Files API' +
      ' helper.',
  },
  {
    id: 'multimodal_multimodal_tool_results',
    family: 'multimodal',
    pySample: 'multimodal/multimodal_tool_results',
    queries: ['Describe the image.'],
    skip: 'unsupported-in-ts',
    note:
      'The sample is one plugin: `MultimodalToolResultsPlugin`, which lifts' +
      ' `types.Part` values returned by a tool out of the function response' +
      ' and re-injects them as real multimodal content. adk-js ships five' +
      ' plugin modules (core/src/plugins: BasePlugin, GlobalInstructionPlugin,' +
      ' LoggingPlugin, PluginManager, SecurityPlugin) and has no' +
      ' equivalent \u2014 a tool returning image parts is JSON-stringified into' +
      ' the functionResponse like any other value. Independently, the' +
      " sample's `get_image` tool returns the literal placeholder" +
      ' `gs://replace_with_your_image_uri`, so it cannot run unmodified on' +
      ' the Python side either without a real GCS object.',
  },
  {
    id: 'eval_home_automation_agent',
    family: 'evaluation',
    pySample: 'evaluation/home_automation_agent',
    tsAgent: 'evaluation/home_automation_agent',
    // The user turns from the evaluation samples' own evalsets, plus the
    // out-of-range temperature the instruction says to refuse. Every tool is
    // backed by an in-memory dict, so the whole trajectory is deterministic.
    queries: [
      'Turn off device_2.',
      'What is the temperature in the Living Room?',
      'Which devices are currently OFF?',
      'Set the temperature in the Bedroom to 45 degrees.',
    ],
    note:
      'The agent ports one-for-one; what the evaluation family is actually' +
      ' about does not. adk-js has no `adk eval` command, no evalset/test' +
      ' file format, no `EvalConfig`/criteria (tool_trajectory_avg_score,' +
      ' response_match_score, rubric or LLM-judge metrics), no custom-metric' +
      ' plug-in point and no user-simulation driver, and nothing calls the' +
      " sample's `reset_data()` hook between cases. This case therefore" +
      ' compares the agent behaviour the evalsets assert on, one turn at a' +
      ' time, instead of the eval machinery.',
  },
];
