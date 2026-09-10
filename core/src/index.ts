/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {installNodeLogger} from './utils/logger_node.js';

// The Node entry point installs the winston-backed logger. `utils/logger.ts`
// itself must stay free of Node-only imports so that the browser entry point
// can reach it; see https://github.com/google/adk-js/issues/611.
// This call runs after the modules re-exported below are evaluated, so a module
// must log through the `logger` facade instead of holding the result of
// `getLogger()`.
installNodeLogger();

// Also available as `@google/adk/a2a`, which does not evaluate the rest of
// this barrel.
export * from './a2a/index.js';
export {InvocationContext} from './agents/invocation_context.js';
export type {WorkflowInstructionScope} from './agents/invocation_context.js';
export {FileArtifactService} from './artifacts/file_artifact_service.js';
export {GcsArtifactService} from './artifacts/gcs_artifact_service.js';
export {getArtifactServiceFromUri} from './artifacts/registry.js';
export {
  AgentEngineSandboxCodeExecutor,
  type AgentEngineSandboxCodeExecutorOptions,
} from './code_executors/agent_engine_sandbox_code_executor.js';
export {CodeExecutionLanguage} from './code_executors/code_execution_utils.js';
export {
  ContainerCodeExecutor,
  type ContainerCodeExecutorOptions,
} from './code_executors/container_code_executor.js';
export {
  UnsafeLocalCodeExecutor,
  type UnsafeLocalCodeExecutorOptions,
} from './code_executors/unsafe_local_code_executor.js';
export * from './common.js';
export {LocalEnvironment} from './environment/local_environment.js';
export type {LocalEnvironmentOptions} from './environment/local_environment.js';
export {VertexAiMemoryBankService} from './memory/vertex_ai_memory_bank_service.js';
export type {VertexAiMemoryBankServiceOptions} from './memory/vertex_ai_memory_bank_service.js';
export {VertexAiRagMemoryService} from './memory/vertex_ai_rag_memory_service.js';
export type {VertexAiRagMemoryServiceOptions} from './memory/vertex_ai_rag_memory_service.js';
export {DatabaseSessionService} from './sessions/database_session_service.js';
export {getSessionServiceFromUri} from './sessions/registry.js';
export {VertexAiSessionService} from './sessions/vertex_ai_session_service.js';
export type {
  VertexAiCreateSessionRequest,
  VertexAiSessionServiceOptions,
} from './sessions/vertex_ai_session_service.js';
export {GCPSkillRegistry} from './skills/gcp_skill_registry.js';
export type {GCPSkillRegistryOptions} from './skills/gcp_skill_registry.js';
export {
  loadAllSkillsInDir,
  loadSkillFromDir,
  loadSkillFromZipBuffer,
  validateSkillDir,
} from './skills/loader.js';
export {LOAD_WEB_PAGE, loadWebPage} from './tools/load_web_page.js';
export type {LoadWebPageOptions} from './tools/load_web_page.js';
export {OpenApiSpecParser} from './tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
export type {
  OperationEndpoint,
  ParsedOperation,
} from './tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
export {OperationParser} from './tools/openapi_tool/openapi_spec_parser/operation_parser.js';
export type {ApiParameter} from './tools/openapi_tool/openapi_spec_parser/operation_parser.js';
export {ToolAuthHandler} from './tools/openapi_tool/openapi_spec_parser/tool_auth_handler.js';
export type {AuthPreparationResult} from './tools/openapi_tool/openapi_spec_parser/tool_auth_handler.js';
export {OpenAPIToolset} from './tools/openapi_tool/openapi_toolset.js';
export {
  createRestApiTool,
  RestApiTool,
} from './tools/openapi_tool/rest_api_tool.js';
export {FilesRetrieval} from './tools/retrieval/files_retrieval.js';
export type {
  FilesRetrievalConstructorParams,
  FilesRetrievalParams,
} from './tools/retrieval/files_retrieval.js';
export {LoadSkillResourceTool} from './tools/skill/load_skill_resource_tool.js';
export {
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
} from './tools/skill/run_skill_inline_script_tool.js';
export {RunSkillScriptTool} from './tools/skill/run_skill_script_tool.js';
export {SkillToolset} from './tools/skill/skill_toolset.js';

export * from './integrations/agent_registry/agent_registry.js';
export * from './telemetry/google_cloud.js';
export * from './telemetry/setup.js';
// Also available as `@google/adk/tools/mcp`, which does not evaluate the rest
// of this barrel.
export * from './tools/mcp/index.js';
