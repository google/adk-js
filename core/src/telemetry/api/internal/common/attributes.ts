/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** OpenTelemetry GenAI semantic-convention attribute keys. */
export enum GenAiAttr {
  AGENT_DESCRIPTION = 'gen_ai.agent.description',
  AGENT_NAME = 'gen_ai.agent.name',
  CONVERSATION_ID = 'gen_ai.conversation.id',
  OPERATION_NAME = 'gen_ai.operation.name',
  PROVIDER_NAME = 'gen_ai.provider.name',
  SYSTEM = 'gen_ai.system',
  WORKFLOW_NAME = 'gen_ai.workflow.name',
  WORKFLOW_NESTED = 'gen_ai.workflow.nested',
  TOOL_CALL_ID = 'gen_ai.tool.call.id',
  TOOL_CALL_ARGUMENTS = 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT = 'gen_ai.tool.call.result',
  TOOL_DEFINITIONS = 'gen_ai.tool.definitions',
  TOOL_DESCRIPTION = 'gen_ai.tool.description',
  TOOL_NAME = 'gen_ai.tool.name',
  TOOL_TYPE = 'gen_ai.tool.type',
  REQUEST_MODEL = 'gen_ai.request.model',
  REQUEST_TOP_P = 'gen_ai.request.top_p',
  REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens',
  RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons',
  INPUT_MESSAGES = 'gen_ai.input.messages',
  OUTPUT_MESSAGES = 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions',
  USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens',
  USAGE_REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens',
  SKILL_NAME = 'gen_ai.skill.name',
  SKILL_DESCRIPTION = 'gen_ai.skill.description',
  SKILL_RESOURCE_NAME = 'gen_ai.skill.resource.name',
  COMPACTION_TRIGGER = 'gen_ai.compaction.trigger',
  COMPACTION_EVENT_COUNT = 'gen_ai.compaction.event_count',
  COMPACTION_RESULT_EVENT_ID = 'gen_ai.compaction.result_event_id',
  COMPACTION_START_TIMESTAMP = 'gen_ai.compaction.start_timestamp',
  COMPACTION_END_TIMESTAMP = 'gen_ai.compaction.end_timestamp',
}

/** ADK-specific attribute keys outside the GenAI semantic conventions. */
export enum AdkAttr {
  SKILL_ADDITIONAL_TOOLS = 'adk.skill.additional_tools',
  EXPERIMENTAL_GROUNDING_QUERY_COUNT = 'adk.experimental.grounding.query_count',
  EXPERIMENTAL_GROUNDING_CHUNK_COUNT = 'adk.experimental.grounding.chunk_count',
  EXPERIMENTAL_GROUNDING_WEB_SEARCH_QUERIES = 'adk.experimental.grounding.web_search_queries',
  EXPERIMENTAL_GROUNDING_SOURCE_URIS = 'adk.experimental.grounding.source_uris',
}

/** GCP Vertex agent attribute keys, consumed by the Vertex trace UI. */
export enum GcpAttr {
  INVOCATION_ID = 'gcp.vertex.agent.invocation_id',
  EVENT_ID = 'gcp.vertex.agent.event_id',
  ASSOCIATED_EVENT_IDS = 'gcp.vertex.agent.associated_event_ids',
  DATA = 'gcp.vertex.agent.data',
}

/** Standard OpenTelemetry error classification attribute key. */
export const ERROR_TYPE_ATTR = 'error.type';

/** Standard OpenTelemetry end-user identifier attribute key. */
export const USER_ID_ATTR = 'user.id';

/** Instrumentation scope name identifying ADK as the emitter. */
export const GEN_AI_SYSTEM_VALUE = 'gcp.vertex.agent';

/** Schema URL of the OpenTelemetry semantic conventions ADK emits. */
export const SCHEMA_URL = 'https://opentelemetry.io/schemas/1.44.0';
