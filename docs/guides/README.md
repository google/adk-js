# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript implementation. For the official ADK documentation, visit [adk.dev](https://adk.dev/). For the generated API reference, run `npm run docs`.

A guide covers one code unit in more depth than the published documentation carries, for a developer calling it from their own application. Guides mirror the source path under `core/src/`, so `core/src/tools/retrieval/files_retrieval.ts` is documented at `tools/retrieval/files_retrieval/index.md`.

This index is the only table of contents. A guide that is not listed here is unreachable, so add the entry in the same change that adds the guide.

## Index

### Artifacts

Versioned binary and text storage (`Part` payloads) scoped to an individual session or shared across a user's sessions via the `user:` prefix.

- [Artifacts](artifacts/index.md) - `BaseArtifactService`, `InMemoryArtifactService`, `FileArtifactService`, `GcsArtifactService`, and session-bound `ctx.artifactService` (`SessionArtifactService`).

### Auth

Credentials for tools that call protected APIs: how a credential is described, how the agent asks the user for one, and how it is exchanged for the credential a request carries.

- [Auth](auth/index.md) - `AuthCredential`, `AuthConfig`, `AuthHandler`, `AuthPreprocessor`, `AuthSchemeType`, and the OpenAPI credential exchangers.

### Code executors

Executors that let an agent answer by writing code and running it, either server-side in Gemini or client-side in a process, a container or a cloud sandbox.

- [Code executors](code_executors/index.md) - Choosing between server-side and client-side execution, what each executor needs and how safe it is, the code execution processors, and writing a custom executor.

### Events

The record of everything that happens during an invocation, and the side effects attached to it.

- [Event](events/event/index.md) - The `Event` and `EventActions` shapes, `isFinalResponse`, and the fields that diverge from adk-python.

### Memory

Cross-session memory ingestion (`addSessionToMemory`) and retrieval (`searchMemory`) across in-memory keyword stores, Vertex AI RAG Engine corpora, and Vertex AI Agent Engine Memory Bank.

- [Memory](memory/index.md) - `BaseMemoryService`, `InMemoryMemoryService`, `VertexAiRagMemoryService`, `VertexAiMemoryBankService`, and the `LOAD_MEMORY` / `PRELOAD_MEMORY` tools.

### Models

The model an `LlmAgent` calls: the `BaseLlm` contract, the request and response shapes, and how a model name resolves to a class.

- [Models](models/index.md) - `BaseLlm`, `LlmRequest`, `LlmResponse`, `LLMRegistry`, and `Gemini`.

### Planners

Planning for an `LlmAgent` through its `planner` option: the model's built-in thinking, or a Plan-ReAct instruction for a model without it.

- [Planners](planners/index.md) - `BasePlanner`, `BuiltInPlanner`, `PlanReActPlanner`, and the `isBasePlanner` and `isBuiltInPlanner` type guards.

### Sessions

Conversations and their state: the events of each session, and the `app:`, `user:` and `temp:` scopes that state keys can carry.

- [Sessions](sessions/index.md) - `Session`, `State`, `BaseSessionService`, `InMemorySessionService`, `DatabaseSessionService`, `VertexAiSessionService`, and `getSessionServiceFromUri`.
### Runners

- [Runner](runners/index.md) - Running an agent for an application, the entry points, which agent answers a resumed conversation, and archiving a finished conversation into memory.

### Tools

#### Retrieval

Client-side retrieval tools. The agent calls a one-argument search function, your code answers it, and you choose the store, the chunking and the ranking. Start with `BaseRetrievalTool` if you are deciding between these and server-side retrieval.

- [BaseRetrievalTool](tools/retrieval/base_retrieval_tool/index.md) - The abstract base, and how client-side retrieval differs from `VertexRagRetrievalTool`.
- [LlamaIndexRetrieval](tools/retrieval/llama_index_retrieval/index.md) - Answers from a LlamaIndex retriever, or anything with a `retrieve` method.
- [FilesRetrieval](tools/retrieval/files_retrieval/index.md) - Builds the retriever for you from a directory of documents.

#### OpenAPI Tool

- [OpenAPI tool](tools/openapi_tool/index.md) - Turning an OpenAPI specification into one tool per operation, selecting the operations an agent gets, and configuring the credential the requests carry.

#### Application Integration Tool

- [Application Integration tool](tools/application_integration_tool/index.md) - Tools for a Google Cloud Application Integration API trigger, or for the entities and actions of an Integration Connectors connection, and the credential they carry.

#### Google API Tool

- [Google API tool](tools/google_api_tool/index.md) - Converting Google API Discovery documents into OpenAPI v3 tools, configuring OpenID Connect credentials, and using pre-configured Google API toolsets.

### Telemetry

- [Telemetry](telemetry/index.md) - The spans and attributes ADK writes, attaching exporters with `maybeSetOtelProviders`, and turning off message content in spans.
