/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** OpenTelemetry GenAI semantic-convention span attribute keys. */
export enum GenAiAttr {
  AGENT_DESCRIPTION = 'gen_ai.agent.description',
  AGENT_NAME = 'gen_ai.agent.name',
  CONVERSATION_ID = 'gen_ai.conversation.id',
  OPERATION_NAME = 'gen_ai.operation.name',
  SYSTEM = 'gen_ai.system',
  TOOL_CALL_ID = 'gen_ai.tool.call.id',
  TOOL_DESCRIPTION = 'gen_ai.tool.description',
  TOOL_NAME = 'gen_ai.tool.name',
  TOOL_TYPE = 'gen_ai.tool.type',
  REQUEST_MODEL = 'gen_ai.request.model',
  REQUEST_TOP_P = 'gen_ai.request.top_p',
  REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens',
  USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens',
  RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons',
}

/** ADK-specific workflow and node span attribute keys. */
export enum AdkAttr {
  WORKFLOW_NAME = 'adk.workflow.name',
  NODE_PATH = 'adk.node.path',
  NODE_RUN_ID = 'adk.node.run_id',
  NODE_ATTEMPT = 'adk.node.attempt',
  NODE_STATUS = 'adk.node.status',
  NODE_INTERRUPT_COUNT = 'adk.node.interrupt_count',
}

/** GCP Vertex agent span attribute keys, consumed by the Vertex trace UI. */
export enum GcpAttr {
  INVOCATION_ID = 'gcp.vertex.agent.invocation_id',
  SESSION_ID = 'gcp.vertex.agent.session_id',
  EVENT_ID = 'gcp.vertex.agent.event_id',
  LLM_REQUEST = 'gcp.vertex.agent.llm_request',
  LLM_RESPONSE = 'gcp.vertex.agent.llm_response',
  TOOL_CALL_ARGS = 'gcp.vertex.agent.tool_call_args',
  TOOL_RESPONSE = 'gcp.vertex.agent.tool_response',
  DATA = 'gcp.vertex.agent.data',
}

/** Standard OpenTelemetry error classification attribute key. */
export const ERROR_TYPE_ATTR = 'error.type';

/** `gen_ai.system` value identifying the ADK on Vertex as the emitter. */
export const GEN_AI_SYSTEM_VALUE = 'gcp.vertex.agent';
