# Memory Sample (`BaseMemoryService`, `InMemoryMemoryService`, and `MemoryEntry`)

This sample demonstrates how ADK agents ingest completed sessions into `ctx.memoryService` (`BaseMemoryService`) via `addSessionToMemory(session)`, retrieve matching `MemoryEntry` items across sessions via `searchMemory({appName, userId, query})`, and persist a JSON digest of the recalled memories through `ctx.artifactService` with `EventActions.artifactDelta`.

## Overview

`MemoryShowcaseAgent` is a deterministic `BaseAgent` subclass that seeds two completed sessions into `ctx.memoryService` (`InMemoryMemoryService`): one belonging to the active `{appName, userId}` with Lisbon flight, companion, meal, and hotel details, and a second belonging to `'other-user'` to verify tenant isolation. On each turn it calls `searchMemory({appName: ctx.appName, userId: ctx.userId, query})`, saves `memory_digest.json` via `ctx.artifactService.saveArtifact`, and returns the recalled `MemoryEntry` items (`author`, ISO 8601 `timestamp`, and `content`).

## Sample Inputs

- `Who am I traveling to Lisbon with and what meal did I request?`

  _Searches the active user's indexed sessions in `ctx.memoryService`, saves `memory_digest.json` via `ctx.artifactService`, and returns the matching Lisbon flight and hotel memories while excluding `'other-user'`._

- `Which Lisbon hotel did we confirm and what check-in note was saved?`

  _Exercises `searchMemory` for the hotel and check-in terms in `adk web` and surfaces both the `recallUserMemories` tool chip and the `memory_digest.json` artifact chip._

## Running the Sample

Run the self-contained `InMemoryRunner` script directly to inspect each emitted `Event` and confirm that an unindexed user sees zero memories:

```bash
npx tsx samples/memory/agent.ts
```

Or run the exported `rootAgent` interactively through the ADK CLI after building the workspace:

```bash
npm run build
npm run sample -- samples/memory/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Memory](../../docs/guides/memory/index.md) - `BaseMemoryService`, `InMemoryMemoryService`, `VertexAiRagMemoryService`, `VertexAiMemoryBankService`, and the `LOAD_MEMORY` / `PRELOAD_MEMORY` tools.
