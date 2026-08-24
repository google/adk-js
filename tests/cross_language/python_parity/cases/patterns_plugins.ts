/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const PATTERN_CASES: ParityCase[] = [
  {
    id: 'pattern_json_passing_agent',
    family: 'patterns',
    pySample: 'patterns/json_passing_agent',
    tsAgent: 'patterns/json_passing_agent',
    // The single turn the sample's own main.py and README both use.
    queries: [
      "I'd like a large pizza with pepperoni and mushrooms on a thin crust.",
    ],
    note:
      'Structured hand-off between sub-agents: the intake agent has both an' +
      ' output schema and tools, and its parsed object is read back by the' +
      ' confirmation agent from `{pizza_order}` and from `toolContext.state`.' +
      ' Both runtimes store the parsed object (not the raw JSON string) under' +
      ' `outputKey`, so `pizza_order` is directly comparable and the price is' +
      ' deterministic ($15.00).',
  },
  {
    id: 'pattern_fields_planner',
    family: 'patterns',
    pySample: 'patterns/fields_planner',
    tsAgent: 'patterns/fields_planner',
    // The message sequence from the sample's own main.py.
    queries: [
      'Hi',
      'Roll a die.',
      'Roll a die again.',
      'What numbers did I got?',
    ],
    volatileStateKeys: ['rolls'],
    note:
      'adk-js has no planners: no `core/src/planners/`, no `BuiltInPlanner`,' +
      ' no `PlanReActPlanner`, and `LlmAgentConfig` has no `planner` field' +
      ' (the only mention is a stale doc comment at' +
      ' core/src/agents/llm_agent.ts:318). `BuiltInPlanner` is however only a' +
      ' carrier for a `ThinkingConfig` — its instruction and response hooks' +
      ' both return None and `apply_thinking_config` just assigns' +
      ' `llm_request.config.thinking_config` — so the TS port sets' +
      ' `generateContentConfig.thinkingConfig` directly, which adk-js passes' +
      ' through unvalidated. What the run then shows is whether both' +
      ' runtimes surface `thought` parts the same way. The PlanReActPlanner' +
      ' half of the sample (commented out upstream) has no equivalent at all.',
  },
  {
    id: 'pattern_workflow_triage',
    family: 'patterns',
    pySample: 'patterns/workflow_triage',
    tsAgent: 'patterns/workflow_triage',
    // The README's own example queries: a vague turn that should draw a
    // clarification, then the multi-domain turn that activates both workers.
    queries: ['hi', "What's 1+11? Write a python function to verify it."],
    // Both worker outputs are free-form model prose.
    volatileStateKeys: ['code_agent_output', 'math_agent_output'],
    note:
      'Every piece of the pattern has a direct adk-js equivalent —' +
      ' `beforeAgentCallback` returning `Content` to skip an agent,' +
      ' `ParallelAgent` inside a `SequentialAgent`, `outputKey`, an' +
      ' instruction provider over `ReadonlyContext`, `includeContents:' +
      " 'none'` — so this case is about behaviour, not API surface: whether" +
      ' the manager transfers to `plan_execution_agent` at the same point,' +
      ' and whether the skipped worker produces the same event.',
  },
  {
    id: 'pattern_context_offloading_with_artifact',
    family: 'patterns',
    pySample: 'patterns/context_offloading_with_artifact',
    tsAgent: 'patterns/context_offloading_with_artifact',
    // The three prompts the sample's README suggests.
    queries: [
      'Hi, help me query the North America sales report',
      'help me query EMEA and APAC sales report',
      'Summarize sales report for North America?',
    ],
    note:
      'Three surface gaps, all worked around in the port and none of them' +
      ' fatal: (1) `LoadArtifactsTool._append_artifacts_to_llm_request` is a' +
      ' protected override point in adk-python but' +
      ' `private appendArtifactsToLlmRequest` in adk-js' +
      ' (core/src/tools/load_artifacts_tool.ts), so the subclass has to' +
      ' override the whole `processLlmRequest` and invoke `BaseTool`\u2019s' +
      ' half itself; (2) `Context.saveArtifact(filename, artifact)` accepts' +
      ' no `customMetadata` and there is no `Context.getArtifactVersion`,' +
      ' although `SessionArtifactService` supports both — the tool goes' +
      ' through `toolContext.invocationContext.artifactService` and records' +
      ' the artifact delta by hand; (3) `appendInstructions` exists' +
      ' (core/src/models/llm_request.ts) but is not re-exported from' +
      ' `@google/adk`, so it is inlined. The report bodies are random on both' +
      ' sides, so the summaries will not match verbatim; what is comparable' +
      ' is the tool sequence, the artifact keys, and that the large report' +
      ' never lands in an event.',
  },
  {
    id: 'plugin_plugin_basic',
    family: 'plugins',
    pySample: 'plugins/plugin_basic',
    tsAgent: 'plugins/plugin_basic',
    // The prompt main.py sends.
    queries: ['hello world'],
    note:
      'Two things worth knowing here. First, the sample has no `agent.py`:' +
      ' `__init__.py` re-exports `root_agent` from `main.py`, and' +
      ' `CountInvocationPlugin` is attached to an ad-hoc `InMemoryRunner`' +
      ' inside `main()`. `adk run` never calls `main()`, so the plugin is not' +
      ' installed on either side and the TS port deliberately does not add' +
      ' one; the same plugin on an `App` is what `core_app` compares. What is' +
      ' left to measure is the sample\u2019s void tool — `hello_world` prints' +
      ' and returns nothing — i.e. how each runtime encodes an empty tool' +
      ' result. Second, the id is not `plugin_basic`: the Python shim' +
      ' directory becomes a top-level package name, and `plugin_basic` would' +
      ' shadow the sample package of the same name, so `load_sample` would' +
      ' re-import the shim instead of the sample.',
  },
  {
    id: 'plugin_plugin_debug_logging',
    family: 'plugins',
    pySample: 'plugins/plugin_debug_logging',
    // The sample's own suggested prompts.
    queries: ["What's the weather in Tokyo?", 'Calculate 15 * 7 + 3'],
    skip: 'unsupported-in-ts',
    note:
      'adk-js has no `DebugLoggingPlugin`. core/src/plugins/ ships five' +
      ' modules (base_plugin, global_instruction_plugin, logging_plugin,' +
      ' plugin_manager, security_plugin) against adk-python\u2019s fifteen, and' +
      ' `google.adk.plugins.DebugLoggingPlugin` — which serialises every LLM' +
      ' request/response, tool call, event and session-state snapshot to a' +
      ' YAML file (`output_path`, `include_session_state`,' +
      ' `include_system_instruction`) — is one of the missing ones. The agent' +
      ' half (get_weather/calculate) would port in ten lines, but the sample' +
      ' exists for the plugin, so porting it without one would report a false' +
      ' match. The id follows `plugin_plugin_basic` for the same' +
      ' shim-vs-sample package-name reason.',
  },
  {
    id: 'plugin_reflect_tool_retry_basic',
    family: 'plugins',
    pySample: 'plugins/plugin_reflect_tool_retry/basic',
    // The README's prompt for this sub-sample.
    queries: [
      'Please guess a number! Tell me what number you guess and how is it.',
    ],
    skip: 'unsupported-in-ts',
    note:
      'adk-js has no `ReflectAndRetryToolPlugin` (adk-python' +
      ' src/google/adk/plugins/reflect_retry_tool_plugin.py) and no' +
      ' `ReflectAndRetryModelPlugin`; it also has no `TrackingScope` and' +
      ' neither of the extension points the sample subclasses' +
      ' (`extract_error_from_result`, `_get_scope_key`). The underlying hooks' +
      ' do exist — `onToolErrorCallback` and `afterToolCallback` on adk-js' +
      ' `BasePlugin` — so the gap is the plugin, not the callback surface,' +
      ' but reimplementing its per-tool failure counters, `max_retries`,' +
      ' `throw_exception_if_retry_exceeded` and the reflection payload it' +
      ' feeds back to the model would measure the port rather than adk-js.' +
      ' The sample\u2019s second plugin, `LoggingPlugin`, does exist in adk-js.',
  },
  {
    id: 'plugin_reflect_tool_retry_hallucinating_func_name',
    family: 'plugins',
    pySample: 'plugins/plugin_reflect_tool_retry/hallucinating_func_name',
    // The README's prompt for this sub-sample.
    queries: ['Roll a 6 sided die'],
    skip: 'unsupported-in-ts',
    note:
      'The same missing `ReflectAndRetryToolPlugin` as' +
      ' `plugin_reflect_tool_retry_basic`, and here it is load-bearing in a' +
      ' second way: an `after_model_callback` renames the model\u2019s' +
      ' `roll_die` call to `roll_die_wrong_name`, and only the plugin turns' +
      ' the resulting unknown-tool failure into a retry. adk-js throws' +
      ' outright on a call it cannot resolve ("Function <name> is not found' +
      ' in the toolsDict.", core/src/agents/functions.ts:539) and offers no' +
      ' plugin-level recovery, so a port without the plugin would simply' +
      ' abort the run.',
  },
];
