/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiError,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
} from '@google/genai';

import {FunctionalTestCase, ScenarioName} from '../recording.js';

export const USER_PROMPT = 'hello';
export const SECOND_USER_PROMPT = 'and again';
export const AGENT_NAME = 'some_root_agent';
export const AGENT_DESCRIPTION = 'A sample root agent.';
export const BASE_INSTRUCTION = 'you are helpful';
export const FINAL_TEXT = 'text response';
export const MODEL_NAME = 'gemini-2.5-flash';

export const SPECIALIST_AGENT_NAME = 'some_specialist_agent';
export const SPECIALIST_AGENT_DESCRIPTION = 'A sample specialist agent.';

export const TOOL_NAME = 'some_tool';
export const TOOL_DESCRIPTION = 'A sample tool.';
export const TOOL_ARGS: Readonly<Record<string, unknown>> = {arg1: 'val1'};
export const TOOL_RESULT_PREFIX = 'processed ';
export const TOOL_RESULT = `${TOOL_RESULT_PREFIX}val1`;
export const TOOL_ERROR = new Error('This tool always fails');

export const WORKFLOW_NAME = 'my_workflow';
export const NESTED_WORKFLOW_NAME = 'my_nested_workflow';
export const NODE_NAME = 'some_node';
export const NESTED_AGENT_NAME = 'some_nested_agent';
export const NESTED_AGENT_DESCRIPTION =
  'A sample agent inside a nested workflow.';

export const AGENT_TOOL_WORKFLOW_NAME = 'my_agent_tool_workflow';
export const DELEGATING_AGENT_NAME = 'some_delegating_agent';
export const DELEGATING_AGENT_DESCRIPTION = 'A sample agent that delegates.';
export const DELEGATE_AGENT_NAME = 'some_delegate_agent';
export const DELEGATE_AGENT_DESCRIPTION = 'A sample delegate agent.';

export const NODE_RESULT = 'some result';
export const NODE_USER_ID = 'some_user';
export const NODE_APP_NAME = 'some_app';

export const FIRST_TURN_PROMPT_TOKEN_COUNT = 100;
export const FIRST_TURN_CACHED_TOKEN_COUNT = 40;
export const FIRST_TURN_CANDIDATES_TOKEN_COUNT = 20;
export const FIRST_TURN_THOUGHTS_TOKEN_COUNT = 5;
export const FIRST_TURN_TOTAL_TOKEN_COUNT = 125;

export const SECOND_TURN_PROMPT_TOKEN_COUNT = 150;
export const SECOND_TURN_CACHED_TOKEN_COUNT = 60;
export const SECOND_TURN_CANDIDATES_TOKEN_COUNT = 35;
export const SECOND_TURN_THOUGHTS_TOKEN_COUNT = 15;
export const SECOND_TURN_TOTAL_TOKEN_COUNT = 200;

export const NESTED_TURN_PROMPT_TOKEN_COUNT = 70;
export const NESTED_TURN_CACHED_TOKEN_COUNT = 30;
export const NESTED_TURN_CANDIDATES_TOKEN_COUNT = 10;
export const NESTED_TURN_THOUGHTS_TOKEN_COUNT = 3;
export const NESTED_TURN_TOTAL_TOKEN_COUNT = 83;

export const FIRST_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: FIRST_TURN_PROMPT_TOKEN_COUNT,
  cachedContentTokenCount: FIRST_TURN_CACHED_TOKEN_COUNT,
  candidatesTokenCount: FIRST_TURN_CANDIDATES_TOKEN_COUNT,
  thoughtsTokenCount: FIRST_TURN_THOUGHTS_TOKEN_COUNT,
  totalTokenCount: FIRST_TURN_TOTAL_TOKEN_COUNT,
};

export const SECOND_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: SECOND_TURN_PROMPT_TOKEN_COUNT,
  cachedContentTokenCount: SECOND_TURN_CACHED_TOKEN_COUNT,
  candidatesTokenCount: SECOND_TURN_CANDIDATES_TOKEN_COUNT,
  thoughtsTokenCount: SECOND_TURN_THOUGHTS_TOKEN_COUNT,
  totalTokenCount: SECOND_TURN_TOTAL_TOKEN_COUNT,
};

export const NESTED_TURN_USAGE: GenerateContentResponseUsageMetadata = {
  promptTokenCount: NESTED_TURN_PROMPT_TOKEN_COUNT,
  cachedContentTokenCount: NESTED_TURN_CACHED_TOKEN_COUNT,
  candidatesTokenCount: NESTED_TURN_CANDIDATES_TOKEN_COUNT,
  thoughtsTokenCount: NESTED_TURN_THOUGHTS_TOKEN_COUNT,
  totalTokenCount: NESTED_TURN_TOTAL_TOKEN_COUNT,
};

export const GROUNDING_METADATA: GroundingMetadata = {
  webSearchQueries: ['adk release', 'google-adk pypi'],
  groundingChunks: [
    {web: {uri: 'https://a.test/1', title: 'A'}},
    {web: {uri: 'https://b.test/2', title: 'B'}},
  ],
};

export const STREAMED_TEXT_CHUNKS = ['text ', 'response'] as const;

export const COMPACTION_APP_NAME = 'compaction_app';
export const COMPACTION_USER_ID = 'compaction_user';
export const COMPACTION_SUMMARY = 'a summary of the earlier turns';
export const COMPACTION_SEEDED_INVOCATION_COUNT = 3;
export const COMPACTION_TOKEN_THRESHOLD = 300;
export const COMPACTION_SEEDED_PROMPT_TOKEN_COUNT = 500;
export const COMPACTION_UNREACHABLE_TOKEN_THRESHOLD = 1_000_000;

export const REGISTRY_SKILL_NAME = 'registry-skill';
export const LOCAL_SKILL_NAME = 'local-skill';
export const NONEXISTENT_SKILL_NAME = 'nonexistent-skill';
export const SKILL_DESCRIPTION = 'A sample skill.';
export const SKILL_SCRIPT_OUTPUT_DIR = '/tmp/adk_skill_script_test';

export const MCP_TOOL_DESCRIPTION = 'Echoes back its input.';
export const MCP_SERVER_URL = 'https://mcp.example.com/mcp';
export const MCP_SESSION_ID = 'mcp-session-1';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_AUTHORIZATION = 'Bearer some-secret-token';
export const MCP_REQUEST_BODY = `{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "${TOOL_NAME}"}}`;
export const MCP_RESPONSE_BODY =
  '{"jsonrpc": "2.0", "id": 1, "result": {"isError": false}}';

export const EXPERIMENTAL_OPT_IN = 'gen_ai_latest_experimental';

export const RESOURCE_EXHAUSTED_ERROR = new ApiError({
  message: 'RESOURCE_EXHAUSTED',
  status: 429,
});

export const MODEL_VALUE_ERROR = new Error('boom');

interface SemconvConfig {
  readonly name: string;
  readonly semconvOptIn: string;
  readonly captureContent: string;
}

const SEMCONV_CONFIGS: readonly SemconvConfig[] = [
  {
    name: 'experimental-no-content',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'no_content',
  },
  {
    name: 'experimental-span-only',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_only',
  },
  {
    name: 'experimental-event-only',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'event_only',
  },
  {
    name: 'experimental-span-and-event',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
  },
];

function semconvMatrix(scenario: ScenarioName): FunctionalTestCase[] {
  return SEMCONV_CONFIGS.map((config) => ({
    testId: config.name,
    scenario,
    semconvOptIn: config.semconvOptIn,
    captureContent: config.captureContent,
  }));
}

function experimentalAdkMatrix(scenario: ScenarioName): FunctionalTestCase[] {
  return [true, false].map((experimentalTelemetry) => ({
    testId: experimentalTelemetry
      ? 'experimental-telemetry'
      : 'no-experimental-telemetry',
    scenario,
    captureContent: 'false',
    experimentalTelemetry,
  }));
}

export const ALL_FUNCTIONAL_TEST_CASES: readonly FunctionalTestCase[] = [
  ...semconvMatrix('agent'),
  {
    testId: 'experimental-telemetry-no-capture',
    scenario: 'agent',
    captureContent: 'false',
    experimentalTelemetry: true,
  },
  {
    testId: 'grounding',
    scenario: 'agent',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    experimentalTelemetry: true,
    grounding: true,
  },
  {
    testId: 'inference-error-resource-exhausted',
    scenario: 'agent',
    captureContent: 'false',
    modelException: RESOURCE_EXHAUSTED_ERROR,
    expectError: true,
  },
  {
    testId: 'inference-error-valueerror',
    scenario: 'agent',
    captureContent: 'false',
    modelException: MODEL_VALUE_ERROR,
    expectError: true,
  },
  {
    testId: 'inference-error-valueerror-span-and-event',
    scenario: 'agent',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    modelException: MODEL_VALUE_ERROR,
    expectError: true,
  },
  {
    testId: 'tool-error-valueerror',
    scenario: 'agent',
    captureContent: 'false',
    toolException: TOOL_ERROR,
    expectError: true,
  },
  {
    testId: 'tool-error-valueerror-span-only',
    scenario: 'agent',
    captureContent: 'span_only',
    toolException: TOOL_ERROR,
    expectError: true,
  },
  ...experimentalAdkMatrix('agent_tool'),
  {
    testId: 'token-threshold',
    scenario: 'conversational_agent_compaction',
    captureContent: 'false',
    experimentalTelemetry: true,
    compactionSetup: 'token_threshold',
  },
  {
    testId: 'untriggered',
    scenario: 'conversational_agent_compaction',
    captureContent: 'false',
    experimentalTelemetry: true,
    compactionSetup: 'untriggered',
  },
  {
    testId: 'no-experimental-telemetry',
    scenario: 'conversational_agent_compaction',
    captureContent: 'false',
    experimentalTelemetry: false,
    compactionSetup: 'token_threshold',
  },
  {
    testId: 'experimental-span-and-event',
    scenario: 'mcp',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
  },
  {
    testId: 'http-exchange',
    scenario: 'mcp',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    experimentalTelemetry: true,
    mcpOverHttp: true,
    env: {
      ADK_CAPTURE_MCP_HTTP_BODIES: 'true',
      ADK_CAPTURE_MCP_HTTP_EXCHANGE: 'true',
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST: 'authorization',
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE: 'content-type',
    },
  },
  ...experimentalAdkMatrix('multi_agent'),
  ...experimentalAdkMatrix('nested_agents_in_workflow'),
  ...semconvMatrix('node'),
  {
    testId: 'skill-telemetry-disabled',
    scenario: 'skill',
    captureContent: 'false',
    experimentalTelemetry: false,
    loadedSkills: ['local', 'registry'],
  },
  {
    testId: 'skill-telemetry',
    scenario: 'skill',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedSkills: ['local'],
  },
  {
    testId: 'invalid-skill',
    scenario: 'skill',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedSkills: ['nonexistent'],
  },
  {
    testId: 'skill-resource-telemetry',
    scenario: 'skill',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedResources: ['references', 'assets', 'scripts'],
  },
  {
    testId: 'invalid-skill-resource',
    scenario: 'skill',
    captureContent: 'false',
    experimentalTelemetry: true,
    loadedResources: ['wrong_type', 'wrong_name'],
  },
  {
    testId: 'skill-script-telemetry',
    scenario: 'skill',
    captureContent: 'false',
    experimentalTelemetry: true,
    scriptReturnExitCodes: [0, 1, 10, 20],
  },
  ...semconvMatrix('streaming'),
];
