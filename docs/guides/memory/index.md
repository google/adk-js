# Memory (`BaseMemoryService`, `InMemoryMemoryService`, `VertexAiRagMemoryService`, and `VertexAiMemoryBankService`)

Memory services in the Agent Development Kit store completed conversation sessions and retrieve relevant turns across sessions for the same application and user.

Every backend implements `BaseMemoryService` so agents and tools can search historical sessions without coupling to a storage engine:

- `InMemoryMemoryService` - Stores session events in process memory and matches queries by case-insensitive keyword overlap for local development and unit tests.
- `VertexAiRagMemoryService` - Uploads session transcripts into a Vertex AI RAG Engine corpus and retrieves matching chunks with tenant isolation across shared corpora.
- `VertexAiMemoryBankService` - Generates, stores, and retrieves structured user facts in Vertex AI Agent Engine Memory Bank.

## Introduction

A `Session` holds the turn-by-turn history of one conversation, whereas `BaseMemoryService` indexes completed sessions so an agent can recall facts from earlier conversations with the same user. Calling `addSessionToMemory(session)` ingests a `Session` into the configured backend, and calling `searchMemory({appName, userId, query})` returns a `SearchMemoryResponse` containing `MemoryEntry` items whose `content`, `author`, and ISO 8601 `timestamp` come from matching session events.

During an agent run, `Runner` attaches the configured `BaseMemoryService` to `InvocationContext.memoryService` (`InMemoryRunner` defaults to an `InMemoryMemoryService` instance). Agents reach memory either on demand by registering `LOAD_MEMORY` (`LoadMemoryTool`), which exposes the `load_memory` function declaration to the model, or automatically on every turn by registering `PRELOAD_MEMORY` (`PreloadMemoryTool`), which injects `<PAST_CONVERSATIONS>` into the outgoing `LlmRequest` instructions. Custom tools and callbacks call `toolContext.searchMemory(query)` on `Context`, which automatically forwards the active `appName` and `userId`.

## Get started

Create an `InMemoryMemoryService`, ingest a completed `Session` containing user preferences, and query those memories from a later turn for the same `appName` and `userId`.

```ts
import {
  createEvent,
  InMemoryMemoryService,
  InMemorySessionService,
} from '@google/adk';

const sessionService = new InMemorySessionService();
const memoryService = new InMemoryMemoryService();

const pastSession = await sessionService.createSession({
  appName: 'travel_assistant',
  userId: 'user-42',
});

await sessionService.appendEvent({
  session: pastSession,
  event: createEvent({
    author: 'user',
    timestamp: Date.parse('2025-02-10T09:15:00.000Z'),
    content: {
      role: 'user',
      parts: [{text: 'I prefer aisle seats and vegetarian meals on flights.'}],
    },
  }),
});

await memoryService.addSessionToMemory(pastSession);

const searchResult = await memoryService.searchMemory({
  appName: 'travel_assistant',
  userId: 'user-42',
  query: 'aisle vegetarian flights',
});

for (const entry of searchResult.memories) {
  const text = entry.content.parts?.map((part) => part.text ?? '').join(' ');
  console.log(`[${entry.timestamp}] ${entry.author}: ${text}`);
}
```

## How it works

1. **Session ingestion (`addSessionToMemory`)**: When a session completes or reaches a checkpoint, application code passes the `Session` object to `memoryService.addSessionToMemory(session)`. `InMemoryMemoryService` filters `session.events` to retain events where `(event.content?.parts?.length ?? 0) > 0` and stores them in a two-level null-prototype map (`Object.create(null)`) keyed by `${session.appName}/${session.userId}` and `session.id`.
2. **Tenant-scoped retrieval (`searchMemory`)**: `searchMemory` accepts a `SearchMemoryRequest` (`{appName, userId, query}`) and resolves to a `SearchMemoryResponse` (`{memories: MemoryEntry[]}`). Unlike `adk-python` v0.1.0, which groups events inside `MemoryResult` objects by `session_id`, `adk-js` returns a flat `MemoryEntry[]` array where each entry carries `content` (`@google/genai` `Content`), `author` (`string | undefined`), and `timestamp` (`string | undefined`, formatted via `new Date(event.timestamp).toISOString()`).
3. **Keyword matching in `InMemoryMemoryService`**: `InMemoryMemoryService` splits `req.query.toLowerCase()` on whitespace (`/\s+/`) and extracts lowercase alphabetic words (`/[A-Za-z]+/g`) from the joined `part.text` strings of each stored event. Any event whose word set contains at least one query word is returned as a `MemoryEntry`. Matching is whole-word, so `flight` does not match `flights`. This diverges from `adk-python` v0.1.0, which matched each keyword as a substring of the raw event text; `adk-js` follows the later whole-word behavior, so queries must use whole words that appear in the stored events.
4. **Transcript upload and chunk deduplication in `VertexAiRagMemoryService`**: `VertexAiRagMemoryService` serializes text-bearing session events into newline-delimited JSON lines (`{author, timestamp, text}` with `timestamp` in Unix epoch seconds `event.timestamp / 1000` so corpora stay interoperable with `adk-python`) and uploads the transcript as a RAG file named `adk-memory-v1.<base64url(appName)>.<base64url(userId)>.<base64url(sessionId)>`. On `searchMemory`, it lists up to 10 pages of 100 files to narrow `ragFileIds` to the requesting tenant, calls `retrieveContexts`, filters every returned chunk through `parseSourceDisplayName`, and deduplicates overlapping chunks per session by event timestamp before sorting each session's events chronologically.
5. **Fact extraction and consolidation in `VertexAiMemoryBankService`**: `VertexAiMemoryBankService` sends session events to Vertex AI Agent Engine Memory Bank via `memories.generateInternal` and queries stored facts via `memories.retrieveInternal` scoped to `{app_name: request.appName, user_id: request.userId}`. It also provides `addEventsToMemory` for incremental event lists and `addMemory` for writing explicit `MemoryEntry` facts via `memories.createInternal` or batched consolidation when `customMetadata['enable_consolidation']` is `true`.

## Configuration options

### `SearchMemoryRequest` and `MemoryEntry`

The `SearchMemoryRequest` interface defines the parameters passed to `BaseMemoryService.searchMemory`, and `MemoryEntry` defines each item in `SearchMemoryResponse.memories`.

| Interface / Property          | Type      | Default     | Description                                                                         |
| :---------------------------- | :-------- | :---------- | :---------------------------------------------------------------------------------- |
| `SearchMemoryRequest.appName` | `string`  | Required    | Application name partitioning the memory store.                                     |
| `SearchMemoryRequest.userId`  | `string`  | Required    | User identifier whose past sessions are searched.                                   |
| `SearchMemoryRequest.query`   | `string`  | Required    | Natural-language or keyword query used to match stored memories.                    |
| `MemoryEntry.content`         | `Content` | Required    | `@google/genai` `Content` payload originally produced during a session event.       |
| `MemoryEntry.author`          | `string`  | `undefined` | Producer of the event, such as `'user'`, `'model'`, or a sub-agent name.            |
| `MemoryEntry.timestamp`       | `string`  | `undefined` | ISO 8601 timestamp string converted from the source `Event.timestamp` milliseconds. |

### `VertexAiRagMemoryServiceOptions`

The `VertexAiRagMemoryServiceOptions` interface configures `VertexAiRagMemoryService`.

| Option                    | Type     | Default                                                         | Description                                                                                               |
| :------------------------ | :------- | :-------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `ragCorpus`               | `string` | Required                                                        | Full resource name `projects/{project}/locations/{location}/ragCorpora/{id}` or bare `{id}`.              |
| `similarityTopK`          | `number` | `undefined`                                                     | Maximum number of RAG contexts requested in `query.ragRetrievalConfig.topK`.                              |
| `vectorDistanceThreshold` | `number` | `10`                                                            | Maximum vector distance (`query.ragRetrievalConfig.filter.vectorDistanceThreshold`) for retrieved chunks. |
| `projectId`               | `string` | Segment 1 of `ragCorpus` or `process.env.GOOGLE_CLOUD_PROJECT`  | Google Cloud project owning the RAG corpus.                                                               |
| `location`                | `string` | Segment 3 of `ragCorpus` or `process.env.GOOGLE_CLOUD_LOCATION` | Google Cloud region hosting the RAG corpus endpoint.                                                      |

`resolveRagCorpus` trims `ragCorpus` and throws `Error('ragCorpus is required for VertexAiRagMemoryService.')` when the string is empty. When `ragCorpus` is a bare corpus ID rather than a four-segment `projects/{project}/locations/{location}/...` resource path, both `projectId` and `location` must be supplied either on options or through `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`.

### `VertexAiMemoryBankServiceOptions`

The `VertexAiMemoryBankServiceOptions` interface configures `VertexAiMemoryBankService`.

| Option              | Type     | Default                           | Description                                                                                                                                                                                                                                                                                                                  |
| :------------------ | :------- | :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentEngineId`     | `string` | Required                          | Reasoning Engine numeric or string ID backing the Memory Bank resource.                                                                                                                                                                                                                                                      |
| `projectId`         | `string` | `undefined`                       | Google Cloud project passed to the `@google-cloud/vertexai` `Client`.                                                                                                                                                                                                                                                        |
| `location`          | `string` | `undefined`                       | Google Cloud region passed to the `@google-cloud/vertexai` `Client`.                                                                                                                                                                                                                                                         |
| `expressModeApiKey` | `string` | `undefined`                       | Express Mode is not supported by the default Agent Engine client. `getExpressModeApiKey` throws when it is combined with `projectId` or `location`, and the constructor throws `EXPRESS_MODE_UNSUPPORTED_MESSAGE` when it is set without them. Use `projectId` and `location` with ADC, or inject a pre-configured `client`. |
| `client`            | `Client` | `new Client({project, location})` | Optional pre-configured `@google-cloud/vertexai` `Client` instance.                                                                                                                                                                                                                                                          |

## Advanced applications

### Wiring `LOAD_MEMORY` and `PRELOAD_MEMORY` into an `LlmAgent`

Give an `LlmAgent` either `LOAD_MEMORY` so the model calls `load_memory({query})` when it needs past context, or `PRELOAD_MEMORY` so ADK searches memory before every model call and appends `<PAST_CONVERSATIONS>` to the system instructions.

```ts
import {
  InMemoryMemoryService,
  LlmAgent,
  LOAD_MEMORY,
  PRELOAD_MEMORY,
  Runner,
  InMemorySessionService,
} from '@google/adk';

const memoryService = new InMemoryMemoryService();
const sessionService = new InMemorySessionService();

export const memoryAwareAgent = new LlmAgent({
  name: 'travel_concierge',
  model: 'gemini-flash-latest',
  instruction: 'Answer travel questions using saved user preferences.',
  tools: [LOAD_MEMORY, PRELOAD_MEMORY],
});

const runner = new Runner({
  appName: 'travel_assistant',
  agent: memoryAwareAgent,
  sessionService,
  memoryService,
});
```

### Configuring `VertexAiRagMemoryService` for cross-process persistence

Pass a `VertexAiRagMemoryService` to `Runner` when sessions must persist in a managed Vertex AI RAG corpus across process restarts.

```ts
import {VertexAiRagMemoryService} from '@google/adk';

const ragMemoryService = new VertexAiRagMemoryService({
  ragCorpus:
    'projects/my-cloud-project/locations/us-central1/ragCorpora/travel-memories',
  similarityTopK: 5,
  vectorDistanceThreshold: 0.7,
});
```

## Limitations

- **`InMemoryMemoryService` matches alphabetic tokens only**: `InMemoryMemoryService` extracts tokens with `/[A-Za-z]+/g` and does not index numeric literals or perform semantic embedding similarity. Use `VertexAiRagMemoryService` or `VertexAiMemoryBankService` for semantic search.
- **`VertexAiRagMemoryService` corpus listing budget**: `searchMemory` lists at most `10` pages of `100` files (`1,000` files total) when pre-filtering `ragFileIds` by tenant. If a shared corpus exceeds `1,000` files or listing fails, retrieval runs against the whole corpus and `tenantSource` still filters every returned chunk on `sourceDisplayName` so another user's memories are never returned.
- **Text-only indexing in `LOAD_MEMORY`, `PRELOAD_MEMORY`, and RAG transcripts**: `serializeSessionTranscript`, `LoadMemoryTool`, and `PreloadMemoryTool` read only `part.text` values from `Event.content.parts`; binary `inlineData` and `fileData` payloads belong in `BaseArtifactService`.

## Related samples

- [`samples/memory/`](../../../samples/memory/README.md) - Runnable sample exercising `InMemoryMemoryService`, `addSessionToMemory`, `searchMemory`, tenant isolation, and `EventActions.artifactDelta`.
