/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const TOOL_CASES: ParityCase[] = [
  {
    id: 'tools_function_tools',
    family: 'tools',
    pySample: 'tools/function_tools',
    tsAgent: 'tools/function_tools',
    // The three "Sample Inputs" from the sample's README. The last one is
    // annotated upstream as the prompt that produces two calls in one step.
    queries: [
      'Give me a random number.',
      "Give me a random number up to 50, and tell me if it's even.",
      'Give me a random number and is 44 even?',
    ],
  },
  {
    id: 'tools_parallel_functions',
    family: 'tools',
    pySample: 'tools/parallel_functions',
    tsAgent: 'tools/parallel_functions',
    // The README's "Basic parallel", "Mixed function types" and single-call
    // list-argument tests.
    queries: [
      'Get the weather for New York, London, and Tokyo',
      'Get the weather in Paris, the USD to EUR exchange rate, and the distance between New York and London',
      'Get population data for Tokyo, London, Paris, and Sydney',
    ],
    unorderedTools: true,
    // Every tool appends its call to a per-tool log. adk-python gathers the
    // batch concurrently and mutates the list in place; adk-js awaits the
    // calls one at a time and writes a fresh array. Same entries, order and
    // interleaving are not promised.
    volatileStateKeys: [
      'weather_requests',
      'currency_requests',
      'distance_requests',
      'population_requests',
    ],
  },
  {
    id: 'tools_long_running_functions',
    family: 'tools',
    pySample: 'tools/long_running_functions',
    tsAgent: 'tools/long_running_functions',
    // First two "Sample Inputs" from the README; the third asks for two
    // exports at once, which the third query of function_tools already covers.
    queries: ['Export my data to CSV', 'Start a JSON data export'],
  },
  {
    id: 'tools_pydantic_argument',
    family: 'tools',
    pySample: 'tools/pydantic_argument',
    tsAgent: 'tools/pydantic_argument',
    // Three of the prompts from the sample's main.py: one Optional[model]
    // argument, then each branch of the Union[UserProfile, CompanyProfile].
    queries: [
      'Create an account for Alice, 25 years old, email: alice@example.com, with dark theme and Spanish language preferences',
      'Create a profile for Tech Corp company, software industry, with 150 employees and website techcorp.com',
      'Create an entity profile for Diana, 32 years old, email diana@example.com',
    ],
  },
  {
    id: 'tools_built_in_multi_tools',
    family: 'tools',
    pySample: 'tools/built_in_multi_tools',
    queries: [
      'Roll a 6 sided die and then search for what the Agent Development Kit is.',
    ],
    skip: 'unsupported-in-ts',
    note:
      'adk-js GoogleSearchTool takes no constructor arguments ' +
      '(core/src/tools/google_search_tool.ts:21), so there is no ' +
      "`bypassMultiToolsLimit` counterpart to Python's " +
      '`GoogleSearchTool(bypass_multi_tools_limit=True)`, and core/src/tools ' +
      'contains neither GoogleSearchAgentTool nor DiscoveryEngineSearchTool. ' +
      'The workaround this sample exists to demonstrate — adk-python swaps a ' +
      'built-in tool for a wrapper tool when the agent also has other tools ' +
      '(llm_agent.py `_convert_tool_union_to_tools`) — is unimplemented, so ' +
      'google_search + vertex_ai_search + a function tool cannot be put on ' +
      'one adk-js agent. VertexAiSearchTool does accept bypassMultiToolsLimit ' +
      'but only uses it to skip a Gemini 1.x guard. The sample additionally ' +
      'needs a provisioned Vertex AI Search datastore in ' +
      'VERTEXAI_DATASTORE_ID; its Python module raises ValueError at import ' +
      'when that is unset.',
  },
  {
    id: 'tools_hello_world_stream_fc_args',
    family: 'tools',
    pySample: 'tools/hello_world_stream_fc_args',
    tsAgent: 'tools/hello_world_stream_fc_args',
    // No README or main.py upstream. One short argument and one long one, so
    // the streamed-arguments path is exercised in both shapes.
    queries: [
      'Concatenate the number 42 and the string "hello world".',
      'Write a document containing a two-sentence description of what an AI agent is.',
    ],
    skip: 'requires-streaming',
    note:
      'The sample sets stream_function_call_args, and Vertex rejects that on' +
      ' the unary endpoint both CLIs use for --replay ("streaming function' +
      ' call is not supported in unary API", HTTP 400). The port is fine; it' +
      ' needs a streaming surface to be exercised. Running it anyway did' +
      ' expose a real difference in model-error handling: adk-python let the' +
      ' ClientError escape and the CLI died with exit 1 and no session, while' +
      ' adk-js recorded it on the event (errorCode/errorMessage), finished' +
      ' the run and saved the session.',
  },
  {
    id: 'tools_agent_tool_with_grounding_metadata',
    family: 'tools',
    pySample: 'tools/agent_tool_with_grounding_metadata',
    queries: [
      'Roll a 6 sided die and then ask the vertex_ai_search_agent what the Agent Development Kit is.',
    ],
    skip: 'unsupported-in-ts',
    note:
      'adk-js AgentToolConfig is `{agent, skipSummarization}` ' +
      '(core/src/tools/agent_tool.ts:26) — there is no ' +
      '`propagateGroundingMetadata` option and AgentTool.runAsync never ' +
      "copies the inner agent's groundingMetadata onto the calling agent's " +
      'event, which is the entire subject of this sample. It also needs a ' +
      'provisioned Vertex AI Search datastore in VERTEXAI_DATASTORE_ID; its ' +
      'Python module raises ValueError at import when that is unset.',
  },
  {
    id: 'tools_output_schema_with_tools',
    family: 'tools',
    pySample: 'tools/output_schema_with_tools',
    tsAgent: 'tools/output_schema_with_tools',
    // The query the README documents the expected PersonInfo payload for.
    queries: ['Tell me about Albert Einstein.'],
  },
];
