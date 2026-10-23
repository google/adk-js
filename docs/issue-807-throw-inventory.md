## Stage 1 inventory: bare `throw new Error(` in `core/src`

Measured on `main` @ `934d6bf`. The count has grown since the issue was filed:

```
$ git grep -n "throw new Error(" -- 'core/src/**/*.ts' | wc -l
340   (124 files; the issue measured 232 / 90 on bb2dd8f)
```

### Summary

| Bucket                                                                                  |   Sites |
| --------------------------------------------------------------------------------------- | ------: |
| **Existing type**                                                                       | **185** |
| `InputValidationError`                                                                  |     154 |
| `NotFoundError`                                                                         |      15 |
| `ToolExecutionError` (BAD_REQUEST 3, FORBIDDEN 2, NOT_FOUND 1, INTERNAL_SERVER_ERROR 1) |       7 |
| `AlreadyExistsError`                                                                    |       6 |
| `SessionNotFoundError`                                                                  |       3 |
| **New type needed**                                                                     | **105** |
| **Keep bare `Error`** (abstract-base stubs, unreachable, lifecycle/internal invariants) |  **49** |
| Not code (`a2a/auth.ts:37` is inside a JSDoc example)                                   |       1 |
| **Total**                                                                               | **340** |

### Proposed new types

Like #583, these are kept flat (`extends Error`). adk-python's `errors/` package has **no equivalent for any of them**: at these spots it raises a builtin `ValueError` / `NotImplementedError` / `ImportError`, or lets the client library's error through.

| Type                        | Sites | Definition                                                                                                                         | Where                                                                                                                                                                              |
| --------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnsupportedFeatureError`   |    35 | The model, backend, runtime or build doesn't support the requested capability, or an optional peer package isn't installed.        | Built-in tools on Gemini 1.x, `runLive` on LangGraph/Parallel/Remote agents, BIDI streaming, code-exec languages, the web-build `crypto_shim`, `optional_peer.ts`, A2A task cancel |
| `UpstreamServiceError`      |    25 | An external HTTP/RPC service or model failed, timed out, or returned unusable data. Should carry an optional `status` and `cause`. | API Hub, Application Integration, Discovery, MCP, RemoteAgent, Vertex LRO polling, empty LLM summary                                                                               |
| `InvalidWorkflowGraphError` |    16 | A workflow graph definition can't be parsed or fails structural validation.                                                        | `workflow/utils/graph_parser.ts`, `graph_validation.ts`, `workflow_graph_utils.ts:111`, `workflow.ts:638`                                                                          |
| `SkillFormatError`          |    11 | A skill package (SKILL.md, zip, registry payload) is malformed or unsafe.                                                          | `skills/loader.ts`, `gcp_skill_registry.ts:61`                                                                                                                                     |
| `AuthenticationError`       |     9 | Credentials are missing or rejected, or a token fetch/exchange/refresh failed.                                                     | ADC / service-account exchangers, OAuth2 token request, the A2A bearer check, agent-registry refresh                                                                               |
| `ServiceNotConfiguredError` |     9 | The operation needs an optional service (artifact, memory, speech) that was never configured.                                      | `agents/context.ts`, `instructions.ts:55`, `code_execution_request_processor.ts:495`, `audio_transcriber.ts:134`, tool context                                                     |

`InvalidWorkflowGraphError` and `SkillFormatError` are both specialised forms of input validation. If maintainers would rather not add types, those 27 sites can fall back to `InputValidationError` without losing much. `UnsupportedFeatureError`, `UpstreamServiceError` and `AuthenticationError` are the ones callers would most plausibly branch on.

### `_stale_session_error.py`: not needed

adk-python raises `StaleSessionError` when an `append_event` loses an optimistic-concurrency race (`database_session_service.py`). adk-js handles the same situation differently. `core/src/sessions/database_session_service.ts:421-554` sets `sessionWasStale` and **reloads** the session's events instead of throwing, so no throw site corresponds to it. Revisit this only if adk-js switches to python's reject-on-conflict behaviour.

The other private python type, `_invocation_not_found_error.py` (used by rewind), has no counterpart either, because adk-js has no rewind yet.

### Found along the way: rewraps that lose the original error

These rebuild the message from `e.message` / `String(e)` without `{cause: e}`. They should be fixed whenever their area is migrated.

- `skills/loader.ts:154`, `:169`. Also, `:169` labels a Zod schema failure as "Invalid YAML", and the error from `:150` is caught by `:154` and wrapped twice.
- `utils/optional_peer.ts:85`
- `agents/instructions.ts:120`
- `tools/function_tool.ts:296`. This also erases the original type, including a tool's own typed error.
- `tools/openapi_tool/auth/auth_helpers.ts:449`, `:458`
- `a2a/agent_card.ts:205`, `:252`, `:267`
- `integrations/agent_registry/agent_registry.ts:129`, `:172`. `:172` also decides whether to rethrow by matching on `error.message`.
- `code_executors/docker_container.ts:214`
- `tools/application_integration_tool/clients/cloud_request.ts:124` drops the HTTP status.

Other notes:

- `plugins/plugin_manager.ts:119` keeps the cause but hides the original error class.
- `skills/loader.ts:426` has the message "Dangerous zip entry ignored", but the code throws.
- `a2a/auth.ts:68`: the A2A SDK's express handler turns a plain `Error` into an internal error rather than a 401. `a2a/agent_executor.ts:98`, `:220` would map better onto the SDK's own `A2AError.invalidParams` / `unsupportedOperation`.
- One judgement call that differs from python: `sessions/vertex_ai_session_service.ts:321` ("session does not belong to user") is classified as `SessionNotFoundError`, but python raises `ValueError` there.

### Suggested Stage 2 order

| Area                                                                            | Sites | Existing | New | Keep | Notes                                                                                                |
| ------------------------------------------------------------------------------- | ----: | -------: | --: | ---: | ---------------------------------------------------------------------------------------------------- |
| `skills/`                                                                       |    12 |        1 |  11 |    0 | No open PRs touch it. Needs `SkillFormatError` (or `InputValidationError`)                           |
| `workflow/`                                                                     |    37 |       14 |  17 |    6 | Only open PR is #978 (`node_runner.ts`, which has no throw sites). Needs `InvalidWorkflowGraphError` |
| `tools/`                                                                        |   100 |       55 |  37 |    8 | Largest; split by sub-folder (`openapi_tool/`, `apihub_tool/`, `application_integration_tool/`, …)   |
| `a2a/`                                                                          |    21 |       15 |   3 |    2 | Plus the 1 JSDoc non-site                                                                            |
| `code_executors/`, `models/`, `utils/`                                          |    41 |       22 |  10 |    9 |                                                                                                      |
| `memory/`, `auth/`, `integrations/`, `plugins/`                                 |    35 |       23 |   8 |    4 |                                                                                                      |
| `cli/`, `apps/`, `context/`, `environment/`, `features/`, `flows/`, `examples/` |    17 |        9 |   2 |    6 |                                                                                                      |
| `sessions/`, `agents/`, `artifacts/`, `runner/`                                 |    77 |       46 |  17 |   14 | Last: in-flight PRs touch these                                                                      |

`artifacts/` (11/11 existing) and `sessions/` (11 of 13 existing, matching python's `AlreadyExistsError` / `SessionNotFoundError`) are the easiest once their open PRs land.

### Full inventory

Each row: site, short message, bucket, and why.

<details><summary><code>core/src/tools/</code> (100 sites)</summary>

| Site                                                                                 | Message                                                 | Bucket                                             | Note                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `tools/agent_tool.ts:52`                                                             | AgentTool input args must be a plain object             | EXISTING:ToolExecutionError(BAD_REQUEST)           | Model-supplied tool args malformed.                                         |
| `tools/apihub_tool/clients/apihub_client.ts:124`                                     | No versions found in API Hub resource                   | EXISTING:NotFoundError                             | API Hub resource has no versions.                                           |
| `tools/apihub_tool/clients/apihub_client.ts:135`                                     | No specs found in API Hub version                       | EXISTING:NotFoundError                             | API Hub version has no specs.                                               |
| `tools/apihub_tool/clients/apihub_client.ts:146`                                     | No API Hub resource found in path                       | EXISTING:InputValidationError                      | Developer-supplied path resolves to no resource.                            |
| `tools/apihub_tool/clients/apihub_client.ts:201`                                     | API Hub request failed with status N                    | NEW:UpstreamServiceError                           | Non-2xx from API Hub; status should be a field.                             |
| `tools/apihub_tool/clients/apihub_client.ts:338`                                     | Project ID not found in URL or path                     | EXISTING:InputValidationError                      | Developer-supplied API Hub path malformed.                                  |
| `tools/apihub_tool/clients/apihub_client.ts:348`                                     | Location not found in URL or path                       | EXISTING:InputValidationError                      | Developer-supplied API Hub path malformed.                                  |
| `tools/apihub_tool/clients/apihub_client.ts:357`                                     | API id not found in URL or path                         | EXISTING:InputValidationError                      | Developer-supplied API Hub path malformed.                                  |
| `tools/apihub_tool/clients/secret_client.ts:124`                                     | No creds and default credentials failed                 | NEW:AuthenticationError                            | ADC lookup failed; wrapper keeps cause.                                     |
| `tools/apihub_tool/clients/service_account.ts:17`                                    | Invalid service account JSON                            | EXISTING:InputValidationError                      | Developer JSON unparsable; wrapper keeps cause.                             |
| `tools/application_integration_tool/application_integration_toolset.ts:124`          | Either (integration and trigger) or (connection ...)    | EXISTING:InputValidationError                      | Constructor options incomplete.                                             |
| `tools/application_integration_tool/application_integration_toolset.ts:268`          | serviceAccountJson must hold a JSON object              | EXISTING:InputValidationError                      | Developer config wrong shape; JSON.parse above throws untyped SyntaxError.  |
| `tools/application_integration_tool/clients/cloud_request.ts:50`                     | MISSING_CREDENTIALS_MESSAGE                             | NEW:AuthenticationError                            | ADC token fetch failed; keeps cause.                                        |
| `tools/application_integration_tool/clients/cloud_request.ts:53`                     | MISSING_CREDENTIALS_MESSAGE                             | NEW:AuthenticationError                            | ADC returned empty token.                                                   |
| `tools/application_integration_tool/clients/cloud_request.ts:120`                    | Request error: msg                                      | NEW:UpstreamServiceError                           | Network failure on fetch; keeps cause.                                      |
| `tools/application_integration_tool/clients/cloud_request.ts:124`                    | invalidRequestMessage (400/404)                         | EXISTING:InputValidationError                      | Service rejected developer-supplied project/location/etc; HTTP status lost. |
| `tools/application_integration_tool/clients/cloud_request.ts:127`                    | Request error: HTTP N for url                           | NEW:UpstreamServiceError                           | Other non-2xx from Google Cloud API; status should be field.                |
| `tools/application_integration_tool/clients/connections_client.ts:716`               | Failed to get entity schema and operations              | NEW:UpstreamServiceError                           | Connectors API response lacks operation name.                               |
| `tools/application_integration_tool/clients/connections_client.ts:745`               | Failed to get action schema for action                  | NEW:UpstreamServiceError                           | Connectors API response lacks operation name.                               |
| `tools/application_integration_tool/clients/integration_client.ts:130`               | response carries no openApiSpec string                  | NEW:UpstreamServiceError                           | Malformed upstream response; rewrapped by unexpectedError at :138.          |
| `tools/application_integration_tool/clients/integration_client.ts:134`               | openApiSpec is not a JSON object                        | NEW:UpstreamServiceError                           | Malformed upstream response; rewrapped by unexpectedError at :138.          |
| `tools/application_integration_tool/clients/integration_client.ts:162`               | No entity operations or actions provided                | EXISTING:InputValidationError                      | Developer config missing operations/actions.                                |
| `tools/application_integration_tool/clients/integration_client.ts:238`               | Invalid operation for entity                            | EXISTING:InputValidationError                      | Developer entityOperations contains unknown op.                             |
| `tools/base_tool.ts:174`                                                             | Duplicate tool name                                     | EXISTING:AlreadyExistsError                        | Tool name already registered on request.                                    |
| `tools/built_in_tool.ts:54`                                                          | extends BuiltInTool but returns a declaration           | KEEP                                               | Subclass authoring bug; programmer error.                                   |
| `tools/enterprise_web_search_tool.ts:39`                                             | cannot be used with other tools in Gemini 1.x           | NEW:UnsupportedFeatureError                        | Model capability limit.                                                     |
| `tools/enterprise_web_search_tool.ts:49`                                             | not supported for model X                               | NEW:UnsupportedFeatureError                        | Built-in tool unsupported on model.                                         |
| `tools/example_tool.ts:56`                                                           | ExampleTool should not be called by model               | KEEP                                               | Unreachable; tool not declared to model.                                    |
| `tools/forwarding_artifact_service.ts:58`                                            | Artifact service is not initialized                     | NEW:ServiceNotConfiguredError                      | Runner built without artifactService.                                       |
| `tools/function_tool.ts:235`                                                         | Tool name cannot be empty                               | EXISTING:InputValidationError                      | Developer constructor options.                                              |
| `tools/function_tool.ts:296`                                                         | Error in tool 'x': msg                                  | EXISTING:ToolExecutionError(INTERNAL_SERVER_ERROR) | Rethrow wrapper loses cause and original type; add {cause}.                 |
| `tools/function_tool.ts:397`                                                         | requires confirmation but no tool context               | KEEP                                               | Internal invariant; runner always supplies context.                         |
| `tools/google_api_tool/googleapi_to_openapi_converter.ts:528`                        | HTTP Error N: Failed to fetch Google API spec           | NEW:UpstreamServiceError                           | Discovery API non-2xx (404 for bad api name).                               |
| `tools/google_api_tool/googleapi_to_openapi_converter.ts:535`                        | Failed to retrieve API specification                    | NEW:UpstreamServiceError                           | Discovery API returned empty spec.                                          |
| `tools/google_maps_grounding_tool.ts:31`                                             | cannot be used with Gemini 1.x models                   | NEW:UnsupportedFeatureError                        | Model capability limit.                                                     |
| `tools/google_maps_grounding_tool.ts:44`                                             | not supported for model X                               | NEW:UnsupportedFeatureError                        | Built-in tool unsupported on model.                                         |
| `tools/google_search_tool.ts:37`                                                     | can not be used with other tools in Gemini 1.x          | NEW:UnsupportedFeatureError                        | Model capability limit.                                                     |
| `tools/google_search_tool.ts:57`                                                     | not supported for model X                               | NEW:UnsupportedFeatureError                        | Built-in tool unsupported on model.                                         |
| `tools/langchain_tool.ts:322`                                                        | Failed to build function declaration for Langchain tool | EXISTING:InputValidationError                      | Developer's Langchain tool schema unusable; keeps cause.                    |
| `tools/load_memory_tool.ts:69`                                                       | Memory service is not initialized                       | NEW:ServiceNotConfiguredError                      | Runner built without memoryService; inside try block.                       |
| `tools/load_web_page.ts:42`                                                          | Unsupported url scheme                                  | EXISTING:ToolExecutionError(BAD_REQUEST)           | Model-supplied URL not http(s).                                             |
| `tools/load_web_page.ts:45`                                                          | Blocked host                                            | EXISTING:ToolExecutionError(FORBIDDEN)             | SSRF guard on model-supplied localhost URL.                                 |
| `tools/load_web_page.ts:54`                                                          | Blocked host                                            | EXISTING:ToolExecutionError(FORBIDDEN)             | SSRF guard: resolves to non-global address.                                 |
| `tools/mcp/mcp_session_manager.ts:231`                                               | Failed to create MCP session                            | NEW:UpstreamServiceError                           | MCP server connect failed; keeps cause.                                     |
| `tools/mcp/mcp_toolset.ts:169`                                                       | Resource with name not found                            | EXISTING:NotFoundError                             | Caller asked for unknown MCP resource.                                      |
| `tools/mcp/mcp_toolset.ts:190`                                                       | Resource has no URI                                     | NEW:UpstreamServiceError                           | MCP server returned malformed resource listing.                             |
| `tools/openapi_tool/auth/auth_helpers.ts:190`                                        | Basic Authentication is not supported                   | NEW:UnsupportedFeatureError                        | Basic auth credentials unsupported.                                         |
| `tools/openapi_tool/auth/auth_helpers.ts:192`                                        | Invalid HTTP auth credentials                           | EXISTING:InputValidationError                      | Developer credential lacks token.                                           |
| `tools/openapi_tool/auth/auth_helpers.ts:285`                                        | Invalid location for apiKey                             | EXISTING:InputValidationError                      | Developer-supplied apiKey location.                                         |
| `tools/openapi_tool/auth/auth_helpers.ts:311`                                        | Invalid security scheme type                            | KEEP                                               | Commented unreachable from typed callers.                                   |
| `tools/openapi_tool/auth/auth_helpers.ts:379`                                        | Invalid OpenID Connect configuration                    | EXISTING:InputValidationError                      | Developer OIDC config fails zod.                                            |
| `tools/openapi_tool/auth/auth_helpers.ts:401`                                        | Missing required fields in credential_dict              | EXISTING:InputValidationError                      | Developer credential dict incomplete.                                       |
| `tools/openapi_tool/auth/auth_helpers.ts:446`                                        | responded with status N                                 | KEEP                                               | Local control flow; caught and rewrapped at :449.                           |
| `tools/openapi_tool/auth/auth_helpers.ts:449`                                        | Failed to fetch OpenID configuration                    | NEW:UpstreamServiceError                           | OIDC discovery fetch failed; wrapper loses cause (String(e) only).          |
| `tools/openapi_tool/auth/auth_helpers.ts:458`                                        | Invalid JSON from OpenID configuration endpoint         | NEW:UpstreamServiceError                           | Malformed upstream body; wrapper loses cause.                               |
| `tools/openapi_tool/auth/auth_helpers.ts:494`                                        | Invalid API Key location                                | EXISTING:InputValidationError                      | Auth scheme from spec/developer invalid.                                    |
| `tools/openapi_tool/auth/auth_helpers.ts:514`                                        | Basic Authentication is not supported                   | NEW:UnsupportedFeatureError                        | Basic auth credentials unsupported.                                         |
| `tools/openapi_tool/auth/auth_helpers.ts:516`                                        | Invalid HTTP auth credentials                           | EXISTING:InputValidationError                      | Developer credential lacks token.                                           |
| `tools/openapi_tool/auth/auth_helpers.ts:524`                                        | Invalid security scheme and credential combination      | EXISTING:InputValidationError                      | Developer paired mismatched scheme/credential.                              |
| `tools/openapi_tool/auth/auth_helpers.ts:534`                                        | Invalid security scheme data                            | EXISTING:InputValidationError                      | Scheme dict fails zod.                                                      |
| `tools/openapi_tool/auth/auth_helpers.ts:559`                                        | Missing 'type' field in security scheme                 | EXISTING:InputValidationError                      | Scheme dict missing type.                                                   |
| `tools/openapi_tool/auth/auth_helpers.ts:573`                                        | Invalid security scheme type                            | EXISTING:InputValidationError                      | Scheme dict has unknown type.                                               |
| `tools/openapi_tool/auth/credential_exchangers/base_auth_credential_exchanger.ts:47` | Subclasses must implement exchangeCredential            | KEEP                                               | Abstract base not-implemented.                                              |
| `tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.ts:32`               | auth_credential is empty                                | EXISTING:InputValidationError                      | Developer omitted credential.                                               |
| `tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.ts:41`               | Invalid security scheme, expect oauth2/OIDC             | EXISTING:InputValidationError                      | Wrong scheme type passed to exchanger.                                      |
| `tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.ts:48`               | auth_credential is not configured with oauth2           | EXISTING:InputValidationError                      | Credential lacks oauth2/http config.                                        |
| `tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.ts:130`              | authScheme is required for OAuth2 exchange              | EXISTING:InputValidationError                      | Caller omitted authScheme.                                                  |
| `tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.ts:157`     | Token endpoint responded with HTTP N                    | NEW:AuthenticationError                            | OAuth token exchange rejected; status should be field.                      |
| `tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.ts:221`     | Failed to get access token from default credentials     | NEW:AuthenticationError                            | ADC yielded no token.                                                       |
| `tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.ts:277`     | Failed to get access token from explicit credentials    | NEW:AuthenticationError                            | Service account yielded no token.                                           |
| `tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.ts:146`                  | External references not supported                       | NEW:UnsupportedFeatureError                        | Spec uses external $ref.                                                    |
| `tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.ts:242`                  | Unresolved server URL variable                          | EXISTING:InputValidationError                      | Developer spec missing variable default.                                    |
| `tools/openapi_tool/openapi_spec_parser/operation_parser.ts:285`                     | Operation ID is missing                                 | EXISTING:InputValidationError                      | Spec operation lacks operationId.                                           |
| `tools/openapi_tool/openapi_spec_parser/tool_auth_handler.ts:120`                    | State entry is not an AuthCredential                    | KEEP                                               | State key collision; internal invariant.                                    |
| `tools/openapi_tool/openapi_spec_parser/tool_auth_handler.ts:295`                    | authCredential is empty for scheme                      | EXISTING:InputValidationError                      | Developer omitted OAuth2 credential.                                        |
| `tools/openapi_tool/openapi_toolset.ts:48`                                           | Unsupported spec type                                   | EXISTING:InputValidationError                      | Developer specType option outside json/yaml.                                |
| `tools/openapi_tool/openapi_toolset.ts:53`                                           | Either specDict or specStr must be provided             | EXISTING:InputValidationError                      | Constructor options incomplete.                                             |
| `tools/openapi_tool/rest_api_tool.ts:272`                                            | Invalid value for path parameter ('.'/'..')             | EXISTING:ToolExecutionError(BAD_REQUEST)           | Model-supplied path arg rejected (traversal guard).                         |
| `tools/openapi_tool/rest_api_tool.ts:480`                                            | Unsupported security scheme type                        | EXISTING:InputValidationError                      | Serialized operation JSON has bad scheme.                                   |
| `tools/preload_memory_tool.ts:40`                                                    | PreloadMemoryTool should not be called by model         | KEEP                                               | Unreachable; tool not declared to model.                                    |
| `tools/retrieval/files_retrieval.ts:43`                                              | needs optional package, not installed                   | NEW:UnsupportedFeatureError                        | Optional peer dep absent; keeps cause.                                      |
| `tools/retrieval/llama_index_retrieval.ts:80`                                        | retrieved no results for the query                      | EXISTING:ToolExecutionError(NOT_FOUND)             | Retrieval empty during tool run.                                            |
| `tools/skill/run_skill_script_tool.ts:182`                                           | Unsupported wrapper language                            | NEW:UnsupportedFeatureError                        | Script language has no wrapper.                                             |
| `tools/skill/search_skills_tool.ts:17`                                               | requires a configured skill registry                    | EXISTING:InputValidationError                      | Toolset constructed without registry.                                       |
| `tools/skill/skill_toolset.ts:242`                                                   | Duplicate tool name                                     | EXISTING:AlreadyExistsError                        | additionalTools name collision.                                             |
| `tools/skill/skill_toolset.ts:251`                                                   | Duplicate tool name                                     | EXISTING:AlreadyExistsError                        | Toolset-provided name collision.                                            |
| `tools/toolbox_tool.ts:66`                                                           | ToolboxTool requires a ToolboxClientLike                | EXISTING:InputValidationError                      | Constructed without client.                                                 |
| `tools/toolbox_tool.ts:115`                                                          | ToolboxClient does not implement loadTool               | EXISTING:InputValidationError                      | Developer client lacks method.                                              |
| `tools/toolbox_tool.ts:132`                                                          | ToolboxClient does not implement loadToolset            | EXISTING:InputValidationError                      | Developer client lacks method.                                              |
| `tools/toolbox_toolset.ts:193`                                                       | ToolboxToolset requires a ToolboxToolsetClientLike      | EXISTING:InputValidationError                      | Constructed without client.                                                 |
| `tools/toolbox_toolset.ts:322`                                                       | toolNames and toolsetName cannot both be undefined      | EXISTING:InputValidationError                      | Constructor options incomplete.                                             |
| `tools/toolbox_toolset.ts:351`                                                       | ToolboxClient does not implement loadToolset            | EXISTING:InputValidationError                      | Developer client lacks method.                                              |
| `tools/toolbox_toolset.ts:366`                                                       | ToolboxClient does not implement loadTool               | EXISTING:InputValidationError                      | Developer client lacks method.                                              |
| `tools/url_context_tool.ts:33`                                                       | URL context tool not supported for model                | NEW:UnsupportedFeatureError                        | Built-in tool unsupported on model.                                         |
| `tools/url_context_tool.ts:39`                                                       | URL context tool requires Gemini 2+                     | NEW:UnsupportedFeatureError                        | Model capability limit.                                                     |
| `tools/vertex_ai_search_tool.ts:78`                                                  | Either dataStoreId or searchEngineId must be specified  | EXISTING:InputValidationError                      | Constructor options conflict/missing.                                       |
| `tools/vertex_ai_search_tool.ts:84`                                                  | searchEngineId required with dataStoreSpecs             | EXISTING:InputValidationError                      | Constructor options inconsistent.                                           |
| `tools/vertex_ai_search_tool.ts:130`                                                 | Vertex AI search not supported for model                | NEW:UnsupportedFeatureError                        | Built-in tool unsupported on model.                                         |
| `tools/vertex_ai_search_tool.ts:141`                                                 | cannot be used with other tools in Gemini 1.x           | NEW:UnsupportedFeatureError                        | Model capability limit.                                                     |
| `tools/webmcp/webmcp_tool.ts:157`                                                    | document.modelContext is unavailable                    | NEW:UnsupportedFeatureError                        | Runtime environment lacks WebMCP API.                                       |

</details>

<details><summary><code>core/src/agents/</code> (44 sites)</summary>

| Site                                                           | Message                                                | Bucket                        | Note                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------- |
| `agents/base_agent.ts:211`                                     | Cannot update `parentAgent` in clone                   | EXISTING:InputValidationError | Developer passed forbidden override to clone().                           |
| `agents/base_agent.ts:556`                                     | Agent already has a parent agent                       | EXISTING:InputValidationError | Developer reused a sub-agent under two parents; python raises ValueError. |
| `agents/base_agent.ts:578`                                     | Invalid agent name                                     | EXISTING:InputValidationError | Developer-supplied agent name fails identifier check.                     |
| `agents/base_agent.ts:586`                                     | Agent name cannot be 'user'                            | EXISTING:InputValidationError | Developer-supplied agent name is reserved.                                |
| `agents/context.ts:96`                                         | Artifact service is not initialized                    | NEW:ServiceNotConfiguredError | Runner built without artifactService; caller may catch to degrade.        |
| `agents/context.ts:114`                                        | Artifact service is not initialized                    | NEW:ServiceNotConfiguredError | Runner built without artifactService.                                     |
| `agents/context.ts:128`                                        | functionCallId is not set                              | KEEP                          | Internal invariant: requestCredential called outside a tool call.         |
| `agents/context.ts:155`                                        | Artifact service is not initialized                    | NEW:ServiceNotConfiguredError | Runner built without artifactService.                                     |
| `agents/context.ts:170`                                        | Memory service is not initialized                      | NEW:ServiceNotConfiguredError | Runner built without memoryService.                                       |
| `agents/context.ts:185`                                        | functionCallId is not set                              | KEEP                          | Internal invariant: requestConfirmation called outside a tool call.       |
| `agents/functions.ts:792`                                      | No function response events provided                   | KEEP                          | Internal helper precondition, empty array from framework code.            |
| `agents/instructions.ts:55`                                    | Artifact service is not initialized                    | NEW:ServiceNotConfiguredError | `{artifact.x}` template used but no artifactService configured.           |
| `agents/instructions.ts:64`                                    | Artifact ${fileName} not found                         | EXISTING:NotFoundError        | Template references missing artifact (non-optional).                      |
| `agents/instructions.ts:79`                                    | Context variable not found                             | EXISTING:NotFoundError        | Template key absent from session state; python raises KeyError.           |
| `agents/instructions.ts:120`                                   | Failed to serialize value for instruction template     | KEEP                          | Rewrap: loses cause (only e.message); add `{cause: e}`.                   |
| `agents/invocation_context.ts:401`                             | InvocationContext.agent is not set                     | KEEP                          | Internal invariant: node-driven invocation has no agent.                  |
| `agents/langgraph_agent.ts:231`                                | requires graph.getState() when checkpointer configured | EXISTING:InputValidationError | Developer-supplied graph object missing required method.                  |
| `agents/langgraph_agent.ts:251`                                | received no messages from graph.invoke()               | KEEP                          | Supplied graph violated contract; nothing to branch on.                   |
| `agents/langgraph_agent.ts:271`                                | not supported yet for LangGraphAgent (live)            | NEW:UnsupportedFeatureError   | runLive unsupported for this agent; python NotImplementedError.           |
| `agents/live_request_queue.ts:45`                              | Cannot send to a closed queue                          | KEEP                          | Programmer misuse of queue lifecycle.                                     |
| `agents/live_request_queue.ts:74`                              | LiveRequestQueue.get() was aborted                     | KEEP                          | Abort signal; better as AbortError/signal.reason than a new type.         |
| `agents/llm_agent.ts:629`                                      | All tools must be set via LlmAgent.tools               | EXISTING:InputValidationError | Developer config misuse of generateContentConfig.                         |
| `agents/llm_agent.ts:632`                                      | System instruction must be set via instruction         | EXISTING:InputValidationError | Developer config misuse of generateContentConfig.                         |
| `agents/llm_agent.ts:637`                                      | Response schema must be set via output_schema          | EXISTING:InputValidationError | Developer config misuse of generateContentConfig.                         |
| `agents/llm_agent.ts:693`                                      | No model found for agent                               | EXISTING:InputValidationError | No model on agent or any ancestor: developer config.                      |
| `agents/llm_agent.ts:1021`                                     | liveRequestQueue is required for runLiveFlow           | KEEP                          | Internal invariant; Runner.runLive already validates the queue.           |
| `agents/llm_agent.ts:1185`                                     | Max live reconnection attempts reached                 | NEW:UpstreamServiceError      | Live model connection keeps dropping; caller may retry/backoff.           |
| `agents/llm_agent.ts:1910`                                     | Agent not found in the agent tree                      | EXISTING:NotFoundError        | Transfer target name not in tree.                                         |
| `agents/parallel_agent.ts:77`                                  | not supported yet for ParallelAgent (live)             | NEW:UnsupportedFeatureError   | runLive unsupported; python NotImplementedError.                          |
| `agents/processors/agent_transfer_llm_request_processor.ts:54` | toolContext is required                                | KEEP                          | Internal invariant: framework always passes toolContext.                  |
| `agents/processors/code_execution_request_processor.ts:495`    | Artifact service is not initialized                    | NEW:ServiceNotConfiguredError | Code executor output files need artifactService.                          |
| `agents/processors/content_processor_utils.ts:421`             | Cannot merge an empty list of events                   | KEEP                          | Internal helper precondition.                                             |
| `agents/processors/content_processor_utils.ts:430`             | There should be at least one function_response part    | KEEP                          | Internal invariant on framework-built events.                             |
| `agents/processors/content_processor_utils.ts:443`             | There should be at least one function_response part    | KEEP                          | Internal invariant on framework-built events.                             |
| `agents/processors/content_processor_utils.ts:525`             | Last response event has responses for other calls      | EXISTING:InputValidationError | Client-sent function responses mismatch pending call ids.                 |
| `agents/processors/content_processor_utils.ts:545`             | No function call event found for response ids          | EXISTING:InputValidationError | Client answered function calls that don't exist in history.               |
| `agents/processors/request_input_llm_request_processor.ts:171` | (schema mismatch message)                              | EXISTING:InputValidationError | End-user request_input response fails declared schema.                    |
| `agents/remote_agent.ts:186`                                   | subAgents is disabled in RemoteAgent                   | EXISTING:InputValidationError | Developer config passed subAgents.                                        |
| `agents/remote_agent.ts:215`                                   | RemoteAgent request failed with HTTP status            | NEW:UpstreamServiceError      | Remote HTTP >=400; should carry status code.                              |
| `agents/remote_agent.ts:222`                                   | expected a JSON array of events                        | NEW:UpstreamServiceError      | Remote service returned malformed payload.                                |
| `agents/remote_agent.ts:229`                                   | expected each item to be a JSON event object           | NEW:UpstreamServiceError      | Remote service returned malformed event item.                             |
| `agents/remote_agent.ts:258`                                   | not supported yet for RemoteAgent (live)               | NEW:UnsupportedFeatureError   | runLive unsupported; python NotImplementedError.                          |
| `agents/run_config.ts:203`                                     | StreamingMode.BIDI is not supported                    | NEW:UnsupportedFeatureError   | Config selects an unsupported mode; arguably InputValidationError.        |
| `agents/run_config.ts:211`                                     | maxLlmCalls should be less than MAX_SAFE_INTEGER       | EXISTING:InputValidationError | Developer RunConfig out of range.                                         |

</details>

<details><summary><code>core/src/workflow/</code> (37 sites)</summary>

| Site                                         | Message                                   | Bucket                        | Note                                                                |
| -------------------------------------------- | ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `workflow/base_node.ts:113`                  | Node name must be non-empty               | EXISTING:InputValidationError | Developer node config validation.                                   |
| `workflow/base_node.ts:273`                  | START node is never executed              | KEEP                          | Unreachable sentinel invariant.                                     |
| `workflow/node_builders.ts:23`               | wrapped function has no name              | EXISTING:InputValidationError | Anonymous function passed to node() without {name}.                 |
| `workflow/node_context.ts:369`               | custom run id cannot be empty             | EXISTING:InputValidationError | Caller-supplied runId validation.                                   |
| `workflow/nodes/node_tool.ts:56`             | Node has no inputSchema                   | EXISTING:InputValidationError | NodeTool constructed from node lacking inputSchema.                 |
| `workflow/nodes/node_tool.ts:128`            | requires invocation event queue           | KEEP                          | Invoked outside LlmAgent tool-call step; wiring invariant.          |
| `workflow/nodes/node_tool.ts:138`            | requires a function-call id               | KEEP                          | Invoked outside LlmAgent tool-call step; wiring invariant.          |
| `workflow/nodes/node_tool.ts:145`            | node-tool nesting exceeded                | KEEP                          | Recursion guard; could be ToolExecutionError, but no caller branch. |
| `workflow/nodes/parallel_worker.ts:74`       | maxParallelWorkers must be >= 1           | EXISTING:InputValidationError | Developer config validation.                                        |
| `workflow/nodes/tool_node.ts:45`             | does not support long-running tools yet   | NEW:UnsupportedFeatureError   | Feature not implemented yet for ToolNode.                           |
| `workflow/retry_config.ts:79`                | exceptions must contain class names       | EXISTING:InputValidationError | Developer retry config validation.                                  |
| `workflow/utils/graph_parser.ts:49`          | Routing map must not be empty             | NEW:InvalidWorkflowGraphError | Malformed edges definition.                                         |
| `workflow/utils/graph_parser.ts:63`          | Invalid node in fan-out tuple             | NEW:InvalidWorkflowGraphError | Malformed edges definition.                                         |
| `workflow/utils/graph_parser.ts:69`          | Invalid routing map value                 | NEW:InvalidWorkflowGraphError | Malformed edges definition.                                         |
| `workflow/utils/graph_parser.ts:160`         | Consecutive routing maps not allowed      | NEW:InvalidWorkflowGraphError | Malformed edges chain.                                              |
| `workflow/utils/graph_parser.ts:225`         | Invalid edge item type                    | NEW:InvalidWorkflowGraphError | Malformed edges definition.                                         |
| `workflow/utils/graph_validation.ts:28`      | Duplicate node names                      | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:39`      | START node not found                      | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:48`      | Edges from START must not have routes     | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:85`      | Nodes unreachable from START              | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:92`      | START must not have incoming edges        | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:127`     | Duplicate edge found                      | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:148`     | DEFAULT_ROUTE combined with other routes  | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:155`     | Multiple DEFAULT_ROUTE edges              | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/graph_validation.ts:190`     | Unconditional cycle detected              | NEW:InvalidWorkflowGraphError | Graph validation failure.                                           |
| `workflow/utils/rehydration_utils.ts:205`    | already answered / unroutable reply       | EXISTING:InputValidationError | End-user reply to request_input targets unknown/closed interrupt.   |
| `workflow/utils/rehydration_utils.ts:218`    | interrupt response mismatch               | EXISTING:InputValidationError | End-user reply fails interrupt response schema.                     |
| `workflow/utils/workflow_graph_utils.ts:102` | maxParallelWorkers needs parallelWorker   | EXISTING:InputValidationError | Inconsistent buildNode options.                                     |
| `workflow/utils/workflow_graph_utils.ts:111` | ParallelWorker cannot wrap START          | NEW:InvalidWorkflowGraphError | Invalid graph construction; InputValidationError also fine.         |
| `workflow/utils/workflow_graph_utils.ts:114` | no ParallelWorker available               | KEEP                          | Build/registration invariant: module not imported.                  |
| `workflow/utils/workflow_graph_utils.ts:143` | unsupported node-like value               | EXISTING:InputValidationError | Value not buildable into a node (missing builder import).           |
| `workflow/utils/workflow_graph_utils.ts:240` | Node name must be non-empty               | EXISTING:InputValidationError | Override name validation; duplicate of base_node.ts:113.            |
| `workflow/workflow.ts:149`                   | edges and dynamicEntry mutually exclusive | EXISTING:InputValidationError | Workflow config validation.                                         |
| `workflow/workflow.ts:154`                   | requires edges or dynamicEntry            | EXISTING:InputValidationError | Workflow config validation.                                         |
| `workflow/workflow.ts:162`                   | maxConcurrency must be positive integer   | EXISTING:InputValidationError | Workflow config validation.                                         |
| `workflow/workflow.ts:638`                   | multiple terminal nodes produced output   | NEW:InvalidWorkflowGraphError | Runtime graph-shape violation: >1 terminal output.                  |
| `workflow/workflow.ts:675`                   | Node not found in graph                   | KEEP                          | Internal invariant: scheduler names a node the graph lacks.         |

</details>

<details><summary><code>core/src/a2a/</code> (21 sites)</summary>

| Site                              | Message                                                 | Bucket                        | Note                                                                         |
| --------------------------------- | ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `a2a/a2a_remote_agent.ts:137`     | Either AgentCard or Client must be provided             | EXISTING:InputValidationError | Constructor config missing both required options.                            |
| `a2a/a2a_remote_agent.ts:174`     | No events in session to send                            | KEEP                          | Runtime invariant; caught by surrounding try in runAsyncImpl.                |
| `a2a/a2a_remote_agent.ts:303`     | Live mode is not supported in A2ARemoteAgent yet        | NEW:UnsupportedFeatureError   | Live mode unimplemented; python uses NotImplementedError.                    |
| `a2a/agent_card.ts:109`           | Unsupported agent card URL scheme                       | EXISTING:InputValidationError | Developer passed non-http/https/file card URL.                               |
| `a2a/agent_card.ts:141`           | Refusing to fetch agent card from link-local address    | EXISTING:InputValidationError | SSRF refusal on caller-supplied card URL.                                    |
| `a2a/agent_card.ts:173`           | Refusing to follow redirect from agent card endpoint    | EXISTING:InputValidationError | SSRF refusal; remote server returned redirect.                               |
| `a2a/agent_card.ts:205`           | Failed to read agent card from file                     | EXISTING:InputValidationError | Bad file/JSON; rethrow loses cause (only message interpolated).              |
| `a2a/agent_card.ts:252`           | Invalid agent card source URL                           | EXISTING:InputValidationError | Unparseable caller URL; rethrow loses cause.                                 |
| `a2a/agent_card.ts:267`           | Invalid RPC URL in agent card                           | EXISTING:InputValidationError | Malformed URL in fetched card; rethrow loses cause.                          |
| `a2a/agent_card.ts:281`           | RPC URL must use https or loopback http                 | EXISTING:InputValidationError | Security policy on card contents; opt-out flag exists.                       |
| `a2a/agent_card.ts:296`           | RPC URL must have same origin as card                   | EXISTING:InputValidationError | Security policy on card contents; opt-out flag exists.                       |
| `a2a/agent_executor.ts:98`        | message not provided                                    | EXISTING:InputValidationError | Bad incoming A2A request; A2AError.invalidParams gives proper JSON-RPC code. |
| `a2a/agent_executor.ts:220`       | Task cancellation is not supported yet                  | NEW:UnsupportedFeatureError   | Unimplemented; A2AError.unsupportedOperation fits SDK protocol better.       |
| `a2a/agent_to_a2a.ts:161`         | refusing to mount A2A server without authentication     | EXISTING:InputValidationError | Developer omitted authentication config without opt-out.                     |
| `a2a/auth.ts:37`                  | MY_TOKEN is not set                                     | N/A (JSDoc)                   | JSDoc example only, not executable code.                                     |
| `a2a/auth.ts:54`                  | empty A2A bearer token is not valid                     | EXISTING:InputValidationError | Developer passed blank token.                                                |
| `a2a/auth.ts:68`                  | A2A request rejected: missing/invalid Bearer credential | NEW:AuthenticationError       | Remote caller failed auth; SDK maps plain Error to internalError, not 401.   |
| `a2a/part_converter_utils.ts:126` | Not a file part                                         | KEEP                          | Unreachable after caller's type dispatch.                                    |
| `a2a/part_converter_utils.ts:238` | Unknown part kind                                       | EXISTING:InputValidationError | Malformed part from remote A2A peer.                                         |
| `a2a/part_converter_utils.ts:286` | Not a file part                                         | EXISTING:InputValidationError | Remote file part with neither bytes nor uri.                                 |
| `a2a/part_converter_utils.ts:299` | No data in part                                         | EXISTING:InputValidationError | Remote data part missing data.                                               |

</details>

<details><summary><code>core/src/utils/</code> (15 sites)</summary>

| Site                              | Message                                               | Bucket                        | Note                                                                   |
| --------------------------------- | ----------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `utils/client_labels.ts:77`       | Client label must be non-empty string                 | EXISTING:InputValidationError | Caller-supplied argument validation.                                   |
| `utils/crypto_shim.ts:18`         | randomUUID: no secure randomness                      | NEW:UnsupportedFeatureError   | Web bundle lacks Web Crypto; environment cannot support feature.       |
| `utils/crypto_shim.ts:36`         | createHash: PKCE needs sync SHA-256                   | NEW:UnsupportedFeatureError   | PKCE unavailable in web build.                                         |
| `utils/crypto_shim.ts:47`         | randomBytes: no secure randomness                     | NEW:UnsupportedFeatureError   | Web bundle lacks secure randomness source.                             |
| `utils/experimental.ts:77`        | Invalid decorator usage                               | KEEP                          | Decorator applied to unsupported target; programmer error.             |
| `utils/failover_utils.ts:30`      | Initial routing failed, no item selected              | EXISTING:InputValidationError | Developer-supplied router returned no key.                             |
| `utils/failover_utils.ts:37`      | Item not found for key                                | EXISTING:NotFoundError        | Router returned key absent from agents/models map.                     |
| `utils/failover_utils.ts:80`      | Item not found for key                                | EXISTING:NotFoundError        | Failover router returned key absent from map.                          |
| `utils/file_utils.ts:51`          | Path traversal detected                               | EXISTING:InputValidationError | File name (possibly LLM/artifact-supplied) escapes target dir.         |
| `utils/file_utils.ts:81`          | Path traversal detected                               | EXISTING:InputValidationError | Same check after dedup rename.                                         |
| `utils/optional_peer.ts:85`       | requires optional peer dependency                     | NEW:UnsupportedFeatureError   | Optional peer package not installed; swallows original err (no cause). |
| `utils/simple_zod_to_json.ts:74`  | Expected a Zod Object                                 | EXISTING:InputValidationError | Public API given non-ZodObject schema.                                 |
| `utils/simple_zod_to_json.ts:200` | Unsupported Zod schema version                        | KEEP                          | Unreachable after v3/v4 checks unless unknown Zod major.               |
| `utils/ssrf_guard.ts:131`         | Unable to resolve host                                | EXISTING:NotFoundError        | DNS yields no address (load_web_page, a2a agent card).                 |
| `utils/vertex_ai_utils.ts:33`     | Cannot specify project/location and expressModeApiKey | EXISTING:InputValidationError | Mutually exclusive config options.                                     |

</details>

<details><summary><code>core/src/code_executors/</code> (15 sites)</summary>

| Site                                                       | Message                                           | Bucket                        | Note                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `code_executors/agent_engine_sandbox_code_executor.ts:84`  | Unsupported language for Agent Engine Sandbox     | NEW:UnsupportedFeatureError   | Language enum value not supported by backend.                         |
| `code_executors/agent_engine_sandbox_code_executor.ts:114` | Invalid sandbox resource name                     | EXISTING:InputValidationError | Malformed developer-supplied resource name.                           |
| `code_executors/agent_engine_sandbox_code_executor.ts:124` | Invalid agent engine resource name                | EXISTING:InputValidationError | Malformed developer-supplied resource name.                           |
| `code_executors/agent_engine_sandbox_code_executor.ts:134` | Project ID is required                            | EXISTING:InputValidationError | Missing constructor config.                                           |
| `code_executors/agent_engine_sandbox_code_executor.ts:273` | Agent Engine creation op did not complete in time | NEW:UpstreamServiceError      | Vertex LRO polling timeout (gateway-timeout-like).                    |
| `code_executors/agent_engine_sandbox_code_executor.ts:357` | Sandbox creation op did not complete in time      | NEW:UpstreamServiceError      | Vertex LRO polling timeout.                                           |
| `code_executors/built_in_code_executor.ts:63`              | Gemini code execution not supported for model     | NEW:UnsupportedFeatureError   | Configured model lacks capability; python raises ValueError.          |
| `code_executors/container_code_executor.ts:135`            | Either image or dockerPath must be set            | EXISTING:InputValidationError | Missing constructor config.                                           |
| `code_executors/container_code_executor.ts:141`            | timeoutSeconds must be > 0                        | EXISTING:InputValidationError | Invalid constructor config value.                                     |
| `code_executors/container_code_executor.ts:169`            | Unsupported language for ContainerCodeExecutor    | NEW:UnsupportedFeatureError   | Language has no runtime mapping.                                      |
| `code_executors/container_code_executor.ts:252`            | python3 is not installed in the container         | KEEP                          | Environment/image misconfiguration at init; nothing to branch on.     |
| `code_executors/docker_container.ts:51`                    | dockerode package is required                     | KEEP                          | Missing optional dependency; python uses ImportError (missing_extra). |
| `code_executors/docker_container.ts:214`                   | Invalid Docker path                               | EXISTING:InputValidationError | Configured dockerPath not accessible; original fs error dropped.      |
| `code_executors/docker_container.ts:237`                   | Container is already started                      | KEEP                          | Lifecycle state invariant (programmer error).                         |
| `code_executors/docker_container.ts:268`                   | Container is not started                          | KEEP                          | Lifecycle state invariant (programmer error).                         |

</details>

<details><summary><code>core/src/sessions/</code> (13 sites)</summary>

| Site                                        | Message                                                | Bucket                        | Note                                                               |
| ------------------------------------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------ |
| `sessions/database_session_service.ts:116`  | Driver is required when passing options                | EXISTING:InputValidationError | Missing constructor config.                                        |
| `sessions/database_session_service.ts:160`  | Session with id already exists                         | EXISTING:AlreadyExistsError   | Python parity: raises AlreadyExistsError.                          |
| `sessions/database_session_service.ts:435`  | Session not found for appendEvent                      | EXISTING:SessionNotFoundError | Python parity: raises SessionNotFoundError.                        |
| `sessions/db/operations.ts:241`             | Unrecognized postgres connection URI                   | EXISTING:InputValidationError | Bad DB URL; python ValueError.                                     |
| `sessions/db/operations.ts:327`             | Unrecognized MySQL/MariaDB connection URI              | EXISTING:InputValidationError | Bad DB URL; python ValueError.                                     |
| `sessions/db/operations.ts:399`             | Unsupported database URI                               | EXISTING:InputValidationError | Bad DB URL; python ValueError.                                     |
| `sessions/db/operations.ts:430`             | ADK Database schema version not compatible             | KEEP                          | Stored schema mismatch needs migration; single site.               |
| `sessions/registry.ts:40`                   | Unsupported session service URI                        | EXISTING:InputValidationError | Developer config URI scheme unknown.                               |
| `sessions/vertex_ai_session_service.ts:179` | Project ID and Location required / express unsupported | EXISTING:InputValidationError | Missing config; express-mode branch is really unsupported-feature. |
| `sessions/vertex_ai_session_service.ts:204` | App name is not valid                                  | EXISTING:InputValidationError | Python parity: ValueError with same message.                       |
| `sessions/vertex_ai_session_service.ts:226` | Cannot specify both ttl and expireTime                 | EXISTING:InputValidationError | Python parity: ValueError.                                         |
| `sessions/vertex_ai_session_service.ts:259` | Session creation op did not complete in time           | NEW:UpstreamServiceError      | Vertex LRO polling timeout.                                        |
| `sessions/vertex_ai_session_service.ts:321` | Session does not belong to user                        | EXISTING:SessionNotFoundError | Ownership mismatch; python raises ValueError instead.              |

</details>

<details><summary><code>core/src/skills/</code> (12 sites)</summary>

| Site                              | Message                                   | Bucket                 | Note                                                                        |
| --------------------------------- | ----------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `skills/gcp_skill_registry.ts:61` | Skill does not contain zipped filesystem  | NEW:SkillFormatError   | Remote GCP registry response missing zippedFilesystem payload.              |
| `skills/loader.ts:128`            | SKILL.md must start with YAML frontmatter | NEW:SkillFormatError   | Malformed SKILL.md content.                                                 |
| `skills/loader.ts:134`            | frontmatter not properly closed           | NEW:SkillFormatError   | Malformed SKILL.md content.                                                 |
| `skills/loader.ts:150`            | frontmatter must be a YAML mapping        | NEW:SkillFormatError   | Thrown inside try, caught and rewrapped by :154 (double prefix).            |
| `skills/loader.ts:154`            | Invalid YAML in frontmatter               | NEW:SkillFormatError   | Rewrap: interpolates e.message, loses cause; should pass `{cause: e}`.      |
| `skills/loader.ts:169`            | Invalid YAML in frontmatter (schema)      | NEW:SkillFormatError   | Rewrap of Zod error, loses cause; message mislabels schema failure as YAML. |
| `skills/loader.ts:330`            | SKILL.md not found in dir                 | EXISTING:NotFoundError | Skill directory lacks SKILL.md; read errors only logged earlier.            |
| `skills/loader.ts:339`            | Skill name does not match directory       | NEW:SkillFormatError   | SKILL.md name inconsistent with directory name.                             |
| `skills/loader.ts:426`            | Dangerous zip entry ignored               | NEW:SkillFormatError   | Zip-slip entry in external archive; message says "ignored" but throws.      |
| `skills/loader.ts:440`            | SKILL.md not found in zipped filesystem   | NEW:SkillFormatError   | Archive lacks SKILL.md; NotFoundError also defensible.                      |
| `skills/loader.ts:446`            | frontmatter must contain 'name'           | NEW:SkillFormatError   | Malformed SKILL.md frontmatter.                                             |
| `skills/loader.ts:449`            | Invalid skill name in SKILL.md            | NEW:SkillFormatError   | Name not a bare path segment (traversal guard).                             |

</details>

<details><summary><code>core/src/models/</code> (11 sites)</summary>

| Site                                  | Message                                     | Bucket                        | Note                                                     |
| ------------------------------------- | ------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `models/apigee_llm.ts:73`             | not a valid Apigee model                    | EXISTING:InputValidationError | Malformed model string from developer.                   |
| `models/apigee_llm.ts:90`             | Proxy URL must be provided                  | EXISTING:InputValidationError | Missing config/env var.                                  |
| `models/apigee_llm.ts:189`            | not a valid Apigee model                    | KEEP                          | Unreachable; constructor already validated model.        |
| `models/chrome_prompt_llm.ts:586`     | connect() not supported by ChromeBuiltInLlm | NEW:UnsupportedFeatureError   | No live mode for this backend.                           |
| `models/gemini_llm_connection.ts:71`  | Content must have parts                     | EXISTING:InputValidationError | Caller sent content without parts.                       |
| `models/gemini_llm_connection.ts:152` | Message queue is not initialized            | KEEP                          | Internal lifecycle invariant.                            |
| `models/google_llm.ts:120`            | API key must be provided                    | EXISTING:InputValidationError | Missing credentials config/env var.                      |
| `models/google_llm.ts:405`            | VertexAI project must be provided           | EXISTING:InputValidationError | Missing config/env var.                                  |
| `models/google_llm.ts:410`            | VertexAI location must be provided          | EXISTING:InputValidationError | Missing config/env var.                                  |
| `models/registry.ts:129`              | Model X not found                           | EXISTING:NotFoundError        | No registered LLM class matches name; python ValueError. |
| `models/routed_llm.ts:88`             | No connection yielded                       | KEEP                          | Internal invariant of router generator.                  |

</details>

<details><summary><code>core/src/artifacts/</code> (11 sites)</summary>

| Site                                     | Message                                          | Bucket                        | Note                                                                  |
| ---------------------------------------- | ------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| `artifacts/file_artifact_service.ts:69`  | Invalid root directory                           | EXISTING:InputValidationError | Bad developer root URI; cause preserved.                              |
| `artifacts/file_artifact_service.ts:81`  | Artifact must have inlineData or text            | EXISTING:InputValidationError | Python parity: InputValidationError.                                  |
| `artifacts/file_artifact_service.ts:115` | Artifact fileData must have a fileUri            | EXISTING:InputValidationError | Python parity: InputValidationError.                                  |
| `artifacts/file_artifact_service.ts:415` | Invalid segment: disallowed characters           | EXISTING:InputValidationError | userId/sessionId path-safety check; python uses InputValidationError. |
| `artifacts/file_artifact_service.ts:429` | path escapes storage root                        | EXISTING:InputValidationError | Path traversal refusal; python uses InputValidationError.             |
| `artifacts/file_artifact_service.ts:489` | Session ID required for session-scoped artifacts | EXISTING:InputValidationError | Caller omitted sessionId; python parity.                              |
| `artifacts/file_artifact_service.ts:503` | Absolute artifact filename not permitted         | EXISTING:InputValidationError | Path traversal refusal; python parity.                                |
| `artifacts/file_artifact_service.ts:509` | Artifact filename escapes storage directory      | EXISTING:InputValidationError | Path traversal refusal; python parity.                                |
| `artifacts/gcs_artifact_service.ts:57`   | Artifact must have inlineData or text            | EXISTING:InputValidationError | Python gcs_artifact_service parity.                                   |
| `artifacts/gcs_artifact_service.ts:99`   | Artifact fileData must have a fileUri            | EXISTING:InputValidationError | Python gcs_artifact_service parity.                                   |
| `artifacts/registry.ts:33`               | Unsupported artifact service URI                 | EXISTING:InputValidationError | Developer config URI scheme unknown.                                  |

</details>

<details><summary><code>core/src/plugins/</code> (10 sites)</summary>

| Site                                        | Message                                             | Bucket                        | Note                                                        |
| ------------------------------------------- | --------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `plugins/_reflect_retry_utils.ts:54`        | invocation_id must be provided for INVOCATION scope | KEEP                          | Internal caller always supplies invocationId.               |
| `plugins/_reflect_retry_utils.ts:60`        | Unknown scope                                       | KEEP                          | Exhaustive enum fallthrough, unreachable.                   |
| `plugins/plugin_manager.ts:68`              | Plugin already registered                           | EXISTING:AlreadyExistsError   | Duplicate plugin instance registration.                     |
| `plugins/plugin_manager.ts:71`              | Plugin with name already registered                 | EXISTING:AlreadyExistsError   | Duplicate plugin name.                                      |
| `plugins/plugin_manager.ts:119`             | Error in plugin during callback                     | KEEP                          | Wrapper keeps cause, but erases original typed error class. |
| `plugins/reflect_retry_model_plugin.ts:74`  | maxRetries must be non-negative                     | EXISTING:InputValidationError | Invalid plugin option.                                      |
| `plugins/reflect_retry_model_plugin.ts:292` | model failed N times, retry limit exceeded          | KEEP                          | Opt-in terminal failure; no cause attached, single site.    |
| `plugins/reflect_retry_tool_plugin.ts:102`  | maxRetries must be non-negative                     | EXISTING:InputValidationError | Invalid plugin option.                                      |
| `plugins/tool_call_integrity_plugin.ts:173` | requires Web Crypto API                             | NEW:UnsupportedFeatureError   | Runtime environment lacks crypto.subtle.                    |
| `plugins/tool_call_integrity_plugin.ts:243` | secretKey must be non-empty bytes                   | EXISTING:InputValidationError | Invalid plugin option.                                      |

</details>

<details><summary><code>core/src/memory/</code> (10 sites)</summary>

| Site                                          | Message                                      | Bucket                        | Note                                                      |
| --------------------------------------------- | -------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `memory/vertex_ai_memory_bank_service.ts:134` | agentEngineId is required                    | EXISTING:InputValidationError | Missing constructor config.                               |
| `memory/vertex_ai_memory_bank_service.ts:160` | EXPRESS_MODE_UNSUPPORTED_MESSAGE             | NEW:UnsupportedFeatureError   | Express-mode API key path not supported.                  |
| `memory/vertex_ai_memory_bank_service.ts:560` | memories must contain at least one entry     | EXISTING:InputValidationError | Caller passed empty list; sibling check throws TypeError. |
| `memory/vertex_ai_memory_bank_service.ts:570` | memories[i] must include text only           | EXISTING:InputValidationError | Caller passed non-text parts.                             |
| `memory/vertex_ai_memory_bank_service.ts:584` | memories[i] must include non-whitespace text | EXISTING:InputValidationError | Caller passed empty text.                                 |
| `memory/vertex_ai_rag_api.ts:144`             | Vertex AI RAG file upload was rejected       | NEW:UpstreamServiceError      | API returned error payload.                               |
| `memory/vertex_ai_rag_api.ts:178`             | Vertex AI RAG request failed with status N   | NEW:UpstreamServiceError      | HTTP non-2xx from Vertex; should carry status.            |
| `memory/vertex_ai_rag_memory_service.ts:70`   | ragCorpus is required                        | EXISTING:InputValidationError | Missing constructor config.                               |
| `memory/vertex_ai_rag_memory_service.ts:90`   | projectId is required                        | EXISTING:InputValidationError | Missing config/env var.                                   |
| `memory/vertex_ai_rag_memory_service.ts:96`   | location is required                         | EXISTING:InputValidationError | Missing config/env var.                                   |

</details>

<details><summary><code>core/src/runner/</code> (9 sites)</summary>

| Site                    | Message                                               | Bucket                        | Note                                                    |
| ----------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `runner/runner.ts:202`  | agent must be provided in runner constructor          | EXISTING:InputValidationError | Missing required Runner option.                         |
| `runner/runner.ts:326`  | Session lookup failed: appName must be provided       | EXISTING:InputValidationError | Runner built without appName.                           |
| `runner/runner.ts:330`  | Session not found                                     | EXISTING:SessionNotFoundError | Exact match; caller may create session and retry.       |
| `runner/runner.ts:338`  | CFC is not supported for model                        | NEW:UnsupportedFeatureError   | supportCfc with pre-Gemini-2 model.                     |
| `runner/runner.ts:396`  | No parts in the newMessage                            | EXISTING:InputValidationError | Caller sent empty message.                              |
| `runner/runner.ts:759`  | liveRequestQueue is required for runLive              | EXISTING:InputValidationError | Missing required runLive param.                         |
| `runner/runner.ts:763`  | runLive is only supported for agents                  | NEW:UnsupportedFeatureError   | Root is a bare node/workflow; live unsupported.         |
| `runner/runner.ts:968`  | Function responses resolve to calls from >1 agent     | EXISTING:InputValidationError | Client's function responses span agents; cannot resume. |
| `runner/runner.ts:1122` | Client message may not contain reserved function call | EXISTING:InputValidationError | Client message contains framework-reserved call.        |

</details>

<details><summary><code>core/src/auth/</code> (8 sites)</summary>

| Site                              | Message                                     | Bucket                        | Note                                                        |
| --------------------------------- | ------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `auth/auth_handler.ts:50`         | credentialKey is empty                      | EXISTING:InputValidationError | Auth config missing credentialKey.                          |
| `auth/auth_handler.ts:102`        | Auth Scheme requires authCredential         | EXISTING:InputValidationError | Developer auth config incomplete.                           |
| `auth/auth_handler.ts:106`        | requires oauth2 in authCredential           | EXISTING:InputValidationError | Developer auth config incomplete.                           |
| `auth/auth_handler.ts:124`        | requires clientId and clientSecret          | EXISTING:InputValidationError | Developer auth config incomplete.                           |
| `auth/auth_handler.ts:167`        | Unsupported codeChallengeMethod             | EXISTING:InputValidationError | Config value outside supported set (S256 only).             |
| `auth/auth_handler.ts:200`        | Authorization endpoint not configured       | EXISTING:InputValidationError | Auth scheme config missing endpoint.                        |
| `auth/oauth2/oauth2_utils.ts:82`  | SSRF protection: token endpoint not allowed | EXISTING:InputValidationError | Configured tokenUrl fails SSRF policy.                      |
| `auth/oauth2/oauth2_utils.ts:101` | Token request failed with status N          | NEW:AuthenticationError       | Token endpoint rejected exchange; should carry HTTP status. |

</details>

<details><summary><code>core/src/integrations/</code> (7 sites)</summary>

| Site                                                | Message                                    | Bucket                        | Note                                                                  |
| --------------------------------------------------- | ------------------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| `integrations/agent_registry/agent_registry.ts:74`  | project_id and location must be provided   | EXISTING:InputValidationError | Missing constructor config.                                           |
| `integrations/agent_registry/agent_registry.ts:129` | Failed to refresh Google Cloud credentials | NEW:AuthenticationError       | ADC refresh failed; rethrow loses cause (message only).               |
| `integrations/agent_registry/agent_registry.ts:162` | API request failed with status N           | NEW:UpstreamServiceError      | Agent Registry HTTP non-2xx; should carry status.                     |
| `integrations/agent_registry/agent_registry.ts:172` | API request failed: msg                    | NEW:UpstreamServiceError      | Wraps fetch/JSON errors; loses cause, relies on message string-match. |
| `integrations/agent_registry/agent_registry.ts:275` | MCP Server endpoint URI not found          | EXISTING:NotFoundError        | Registry entry lacks usable endpoint.                                 |
| `integrations/agent_registry/agent_registry.ts:367` | Connection URI not found for endpoint      | EXISTING:NotFoundError        | Registry entry lacks connection URI.                                  |
| `integrations/agent_registry/agent_registry.ts:443` | A2A connection URI not found for Agent     | EXISTING:NotFoundError        | Registry agent lacks A2A interface.                                   |

</details>

<details><summary><code>core/src/features/</code> (3 sites)</summary>

| Site                               | Message                     | Bucket | Note                                                                 |
| ---------------------------------- | --------------------------- | ------ | -------------------------------------------------------------------- |
| `features/feature_registry.ts:85`  | Feature X is not registered | KEEP   | FeatureName is typed enum; unregistered means internal registry bug. |
| `features/feature_registry.ts:108` | Feature X is not registered | KEEP   | Same invariant; typed enum key missing from registry.                |
| `features/feature_registry.ts:164` | Feature X is not registered | KEEP   | Same invariant; typed enum key missing from registry.                |

</details>

<details><summary><code>core/src/environment/</code> (3 sites)</summary>

| Site                                  | Message                        | Bucket                        | Note                                                                    |
| ------------------------------------- | ------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| `environment/base_environment.ts:123` | Environment is not initialized | KEEP                          | Lifecycle misuse by programmer: initialize() not called.                |
| `environment/local_environment.ts:50` | Path escapes working directory | EXISTING:InputValidationError | Caller/LLM-supplied path traverses outside sandbox; security rejection. |
| `environment/local_environment.ts:92` | `workingDir` is not set        | KEEP                          | Lifecycle misuse: initialize() not called.                              |

</details>

<details><summary><code>core/src/context/</code> (3 sites)</summary>

| Site                                                 | Message                                  | Bucket                        | Note                                                     |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `context/summarizers/llm_summarizer.ts:59`           | Cannot summarize an empty list of events | KEEP                          | Caller precondition from compaction code; internal.      |
| `context/summarizers/llm_summarizer.ts:94`           | LLM failed to return a valid summary     | NEW:UpstreamServiceError      | Model returned empty text; caller could skip compaction. |
| `context/trajectory_thought_pruning_compactor.ts:32` | eventRetentionSize must be non-negative  | EXISTING:InputValidationError | Developer constructor option invalid.                    |

</details>

<details><summary><code>core/src/cli/</code> (3 sites)</summary>

| Site                  | Message                                  | Bucket                        | Note                                                                         |
| --------------------- | ---------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `cli/cli_eval.ts:205` | Invalid format for test_config.json      | EXISTING:InputValidationError | User-supplied eval config file lacks `criteria` dict.                        |
| `cli/cli_eval.ts:256` | No rootAgent found in module             | EXISTING:NotFoundError        | User agent module exports no BaseAgent; InputValidationError also plausible. |
| `cli/cli_eval.ts:702` | rootAgent is required to run evaluations | EXISTING:InputValidationError | Caller omitted required rootAgent argument.                                  |

</details>

<details><summary><code>core/src/apps/</code> (3 sites)</summary>

| Site             | Message                    | Bucket                        | Note                                     |
| ---------------- | -------------------------- | ----------------------------- | ---------------------------------------- |
| `apps/app.ts:21` | Invalid app name           | EXISTING:InputValidationError | Developer-supplied app name fails regex. |
| `apps/app.ts:26` | App name cannot be 'user'  | EXISTING:InputValidationError | Developer-supplied app name is reserved. |
| `apps/app.ts:88` | rootAgent must be provided | EXISTING:InputValidationError | Missing required App option.             |

</details>

<details><summary><code>core/src/flows/</code> (1 sites)</summary>

| Site                                       | Message                                            | Bucket                        | Note                                               |
| ------------------------------------------ | -------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `flows/llm_flows/audio_transcriber.ts:134` | SpeechClient is not configured on AudioTranscriber | NEW:ServiceNotConfiguredError | Transcription used without injected speech client. |

</details>

<details><summary><code>core/src/examples/</code> (1 sites)</summary>

| Site                           | Message                       | Bucket                        | Note                                                   |
| ------------------------------ | ----------------------------- | ----------------------------- | ------------------------------------------------------ |
| `examples/example_util.ts:205` | Invalid example configuration | EXISTING:InputValidationError | Examples neither array nor provider: developer config. |

</details>
