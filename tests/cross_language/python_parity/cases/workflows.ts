/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const WORKFLOW_CASES: ParityCase[] = [
  {
    id: 'workflow_sequence',
    family: 'workflows',
    pySample: 'workflows/sequence',
    tsAgent: 'workflows/sequence',
    // The sample takes no input; upstream `tests/go.json` kicks it off with
    // "go" and so does this.
    queries: ['go'],
  },
  {
    id: 'workflow_loop',
    family: 'workflows',
    pySample: 'workflows/loop',
    tsAgent: 'workflows/loop',
    // "flower" is a README sample input and an upstream test fixture: it is
    // graded "unrelated", so the back-edge to generate_headline fires at least
    // once instead of the graph running straight through.
    queries: ['flower'],
    // The grade is deterministic for this topic, the critique text is not.
    volatileStateKeys: ['feedback'],
  },
  {
    id: 'workflow_loop_self',
    family: 'workflows',
    pySample: 'workflows/loop_self',
    tsAgent: 'workflows/loop_self',
    queries: ['3'],
    skip: 'nondeterministic',
    note:
      'Ported and loadable, but not compared: guess_number draws from ' +
      'random.randint(0, 10) / Math.random(), so the number of self-loop ' +
      'iterations — and with it the event count and the whole transcript — ' +
      'differs run to run even between two runs of the same runtime.',
  },
  {
    id: 'workflow_loop_config',
    family: 'workflows',
    pySample: 'workflows/loop_config',
    queries: ['Python programming'],
    skip: 'unsupported-in-ts',
    note:
      'YAML-defined workflow. adk-js has no config-file agent loader at all: ' +
      'nothing corresponds to adk-python `agents/agent_config.py` or its ' +
      '`agent_class:` + `edges:` schema, and `AgentFile` loads TypeScript ' +
      'modules only. Also unrunnable upstream — the sample exports neither ' +
      '`root_agent` nor `app` (only `Feedback`, `process_input`, ' +
      "`route_headline`), and adk-python's own AgentLoader rejects the YAML: " +
      '"Invalid fully qualified name: google.adk.agents.Workflow".',
  },
  {
    id: 'workflow_route',
    family: 'workflows',
    pySample: 'workflows/route',
    tsAgent: 'workflows/route',
    // The three README inputs, one per branch of the routing map:
    // question -> answer_question, statement -> comment_on_statement,
    // other -> handle_other.
    queries: [
      'What is the capital of France?',
      'The weather is very nice today.',
      'Translate bonjour to english',
    ],
  },
  {
    id: 'workflow_state',
    family: 'workflows',
    pySample: 'workflows/state',
    tsAgent: 'workflows/state',
    queries: ['Hello ADK!'],
  },
  {
    id: 'workflow_message',
    family: 'workflows',
    pySample: 'workflows/message',
    tsAgent: 'workflows/message',
    // Purely function-driven; the README says any text starts it.
    queries: ['go'],
  },
  {
    id: 'workflow_node_output',
    family: 'workflows',
    pySample: 'workflows/node_output',
    tsAgent: 'workflows/node_output',
    queries: ['cyberpunk future'],
  },
  {
    id: 'workflow_use_as_output',
    family: 'workflows',
    pySample: 'workflows/use_as_output',
    tsAgent: 'workflows/use_as_output',
    queries: [
      'The quick brown fox jumped over the lazy dog near the riverbank on a' +
        ' warm summer afternoon',
    ],
  },
  {
    id: 'workflow_fan_out_fan_in',
    family: 'workflows',
    pySample: 'workflows/fan_out_fan_in',
    tsAgent: 'workflows/fan_out_fan_in',
    // A README input. The three branches are pure functions, so the whole
    // transcript is deterministic on both sides.
    queries: ['Hello World'],
    // The three branches race; only their arrival order is unpromised.
    unorderedTools: true,
  },
  {
    id: 'workflow_multi_triggers',
    family: 'workflows',
    pySample: 'workflows/multi_triggers',
    tsAgent: 'workflows/multi_triggers',
    queries: ['Hello World'],
    unorderedTools: true,
  },
  {
    id: 'workflow_nested_workflow',
    family: 'workflows',
    pySample: 'workflows/nested_workflow',
    tsAgent: 'workflows/nested_workflow',
    // A README input, and the year upstream's own `tests/1984.json` uses.
    queries: ['1984'],
    unorderedTools: true,
  },
  {
    id: 'workflow_parallel_worker',
    family: 'workflows',
    pySample: 'workflows/parallel_worker',
    tsAgent: 'workflows/parallel_worker',
    // Upstream's fixture is `tests/flower.json`; the README inputs are
    // equivalent. "flower" keeps the related-topic list short and concrete.
    queries: ['flower'],
    unorderedTools: true,
  },
  {
    id: 'workflow_dynamic_fan_out_fan_in',
    family: 'workflows',
    pySample: 'workflows/dynamic_fan_out_fan_in',
    tsAgent: 'workflows/dynamic_fan_out_fan_in',
    // The first README input: three topics, so the orchestrator fans out to
    // three dynamic `generator` runs.
    queries: ['AI, Cloud Computing, Quantum Computing'],
    unorderedTools: true,
  },
  {
    id: 'workflow_dynamic_nodes',
    family: 'workflows',
    pySample: 'workflows/dynamic_nodes',
    tsAgent: 'workflows/dynamic_nodes',
    // "flower" is the README input and upstream's `tests/flower.json`: it is
    // graded "unrelated" first time round, so the `while` loop iterates at
    // least twice instead of running straight through.
    queries: ['flower'],
    // The grade is stable for this topic; the critique text is not.
    volatileStateKeys: ['feedback'],
  },
  {
    id: 'workflow_node_as_tool',
    family: 'workflows',
    pySample: 'workflows/node_as_tool',
    tsAgent: 'workflows/node_as_tool',
    // The README's two-turn HITL script: turn 1 drives both node-tools until
    // `calculate_discount` raises the `confirm_vip_discount` interrupt, turn 2
    // answers it. A plain-text turn is routed to a pending `RequestInput` in
    // both runtimes, so the reply needs no functionResponse envelope.
    queries: ['What discount does customer c123 get?', 'yes'],
    unorderedTools: true,
  },
  {
    id: 'workflow_agent_in_workflow',
    family: 'workflows',
    pySample: 'workflows/agent_in_workflow',
    tsAgent: 'workflows/agent_in_workflow',
    // The README's one-shot input: the task-mode `intake_agent` has both
    // fields immediately, `check_identity` takes the DEFAULT_ROUTE, and
    // `generate_instruction` stops on the `find_orders` confirmation.
    queries: ['I am Jane Doe, my phone number is 555-1234'],
    note:
      'Compared up to the tool-confirmation pause. The final turn upstream ' +
      '(`tests/jane_doe_and_phone_number.json`) is an `adk_request_confirmation` ' +
      'functionResponse with `{confirmed: true}`, and the harness replay file ' +
      'carries plain-text queries only, so neither side can approve ' +
      '`find_orders` and both runs end waiting on it.',
  },
  {
    id: 'workflow_retry',
    family: 'workflows',
    pySample: 'workflows/retry',
    tsAgent: 'workflows/retry',
    queries: ['go'],
    skip: 'nondeterministic',
    note:
      'Ported and loadable, but not compared: `get_weather` fails on ' +
      '`random.random() < 0.7` / `Math.random() < 0.7`, so the attempt count ' +
      '— and with it the number of error events, the retry backoff, and ' +
      'whether the run succeeds at all within maxAttempts=5 — differs run to ' +
      "run even between two runs of the same runtime. Upstream's own " +
      '`tests/go.json` only works because it mocks `random.random`, which ' +
      'the replay-file harness cannot do. One real difference the port does ' +
      "surface: adk-python stamps the error event's `errorCode` with the " +
      'exception class name, while adk-js reads `error.code` and otherwise ' +
      'falls back to "UNKNOWN_ERROR".',
  },
];
