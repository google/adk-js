# VertexAiRagMemoryService

`VertexAiRagMemoryService` is a `BaseMemoryService` that stores finished
sessions in a Vertex AI RAG Engine corpus and retrieves them semantically. Reach
for it when you already run a RAG corpus, or when you want recall across
sessions without standing up an Agent Engine.

## Introduction

A session holds one conversation. A memory service is what lets a _later_
session find what was said in an earlier one. ADK ships three of them, and they
differ in where the text lives and how a query matches it.

`InMemoryMemoryService` keeps everything in the process and matches on shared
words, so it is for prototyping. `VertexAiMemoryBankService` is the managed
option: it consolidates conversations into durable memories, and it needs an
Agent Engine. `VertexAiRagMemoryService` sits between them. It writes each
finished session into a corpus you own as one plain-text transcript file, and a
search is a RAG retrieval query over those transcripts. You get semantic
retrieval and you keep the raw turns.

The corpus is shared with adk-python. The transcript format and the file display
names are the same in both SDKs, so a corpus written by a Python agent is
readable by a TypeScript agent and the other way round.

## Get started

The service needs an existing corpus; it never creates one. Create it with the
Vertex AI RAG Engine, then point the service at its resource name.

```ts
import {
  InMemorySessionService,
  LlmAgent,
  LOAD_MEMORY,
  Runner,
  VertexAiRagMemoryService,
} from '@google/adk';
import {createUserContent} from '@google/genai';

const APP_NAME = 'memory_demo';
const USER_ID = 'user-1';

const runner = new Runner({
  appName: APP_NAME,
  agent: new LlmAgent({
    name: 'memory_agent',
    model: 'gemini-2.5-flash',
    instruction:
      'Answer the user. Call load_memory when the answer might be in an ' +
      'earlier conversation.',
    tools: [LOAD_MEMORY],
  }),
  sessionService: new InMemorySessionService(),
  memoryService: new VertexAiRagMemoryService({
    ragCorpus: process.env.RAG_CORPUS!,
    similarityTopK: 5,
  }),
});

async function ask(sessionId: string, text: string): Promise<void> {
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId,
    newMessage: createUserContent(text),
  })) {
    const reply = event.content?.parts?.[0]?.text;
    if (reply) {
      console.log(reply);
    }
  }
}

const first = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});
await ask(first.id, 'My favorite sport is badminton.');

// Nothing is remembered until the finished session is handed over. Re-read it
// so the ingested copy carries the final events.
const completed = await runner.sessionService.getSession({
  appName: APP_NAME,
  userId: USER_ID,
  sessionId: first.id,
});
await runner.memoryService!.addSessionToMemory(completed!);

const second = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});
await ask(second.id, 'What sport do I like?');
```

Ingestion is explicit. A session reaches the corpus only when someone calls
`addSessionToMemory`, so call it when a conversation finishes.

## Configuration

| Option                    | Meaning                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `ragCorpus`               | Required. `projects/{project}/locations/{location}/ragCorpora/{id}`, or a bare `{id}`. |
| `similarityTopK`          | Number of contexts to retrieve. Sent as `ragRetrievalConfig.topK`.                     |
| `vectorDistanceThreshold` | Only return contexts below this distance. Defaults to `10`.                            |
| `projectId`               | Defaults to `GOOGLE_CLOUD_PROJECT`.                                                    |
| `location`                | Defaults to `GOOGLE_CLOUD_LOCATION`.                                                   |
| `ragApiClient`            | The Vertex RAG client. Defaults to a real one; substitute it in a test.                |

A full resource name supplies the project and the location, so those two options
are only needed for a bare corpus id. The constructor throws when it cannot
resolve either one, rather than failing on the first request.

Calls use Application Default Credentials. The caller needs
`aiplatform.ragFiles.*` and `aiplatform.ragCorpora.*` on the corpus.

## What a search does

`searchMemory({appName, userId, query})` first lists the corpus and keeps the
files whose display name names the requesting app and user, so retrieval ranks
only that tenant's transcripts. The walk reads up to 100 files per page and at
most 10 pages, which keeps the cost of a search independent of how large a
shared corpus grows.

The listing is an optimisation, not the tenant boundary. When it fails, or when
the corpus is larger than the page budget, the service logs a warning and
retrieves over the whole corpus. Every returned context is then filtered by its
display name, so a search never returns another app's or another user's turns on
any path.

Retrieved chunks overlap. The service reassembles them per session, drops the
turns that appear in two chunks, and orders each run by timestamp before
returning `MemoryEntry` objects.

## Display names and older corpora

A transcript file is named
`adk-memory-v1.<appName>.<userId>.<sessionId>`, with each identifier
base64url-encoded. The encoding is what makes an identifier containing a dot
unambiguous.

Older ADK versions wrote the three identifiers as plain dot-separated text. Such
a name is still accepted, but only in its exact three-part form:
`demo.alice.smith.session_secret` names either user `alice` or user
`alice.smith`, and returning it to the wrong one would leak a conversation. A
legacy name with four or more parts is therefore ignored.

## Limitations

- **One corpus per instance.** The Vertex AI RAG Engine supports one corpus per
  `ragResources`. Create one service per corpus.
- **No retention.** Every `addSessionToMemory` adds a file. Nothing deletes or
  expires it.
- **Text only.** A transcript keeps the text parts of an event; images and other
  inline data are dropped at ingestion.
