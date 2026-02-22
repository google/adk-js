# Memory

The Memory system provides long-term context retrieval for agents, enabling them to access relevant information from past conversations and sessions. Memory services index session data and provide search capabilities for retrieving context-relevant information.

## BaseMemoryService Interface

The `BaseMemoryService` interface defines the contract for memory services with two core methods:

```typescript
export interface BaseMemoryService {
  addSessionToMemory(session: Session): Promise<void>;
  searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse>;
}
```

### addSessionToMemory()

Ingests a session into memory storage.

```typescript
addSessionToMemory(session: Session): Promise<void>
```

**Parameters:**
- `session` - Complete `Session` object containing events and metadata

**Returns:** `Promise<void>` when ingestion completes

**Purpose:**
- Index/store session data for later retrieval
- Extract meaningful content from session events
- Prepare data for search queries

**Example:**

```typescript
// After a session completes, add it to memory
const session = await sessionService.getSession({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
});

await memoryService.addSessionToMemory(session);
```

### searchMemory()

Searches for sessions matching a query.

```typescript
searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse>
```

**Parameters:**

```typescript
export interface SearchMemoryRequest {
  appName: string;
  userId: string;
  query: string;
}
```

**Returns:**

```typescript
export interface SearchMemoryResponse {
  memories: MemoryEntry[];
}
```

**Purpose:**
- Retrieve relevant past interactions based on text query
- Enable agents to access historical context
- Support RAG (Retrieval Augmented Generation) patterns

**Example:**

```typescript
const response = await memoryService.searchMemory({
  appName: 'myApp',
  userId: 'user123',
  query: 'what was my last order',
});

for (const memory of response.memories) {
  console.log(`Author: ${memory.author}`);
  console.log(`Time: ${memory.timestamp}`);
  console.log(`Content: ${memory.content.parts[0].text}`);
}
```

## MemoryEntry Structure

Each memory entry represents an individual memory item with context.

```typescript
export interface MemoryEntry {
  content: Content;    // From @google/genai
  author?: string;
  timestamp?: string;
}
```

### Fields

#### content (required)

The actual content of the memory entry.

- Type: `Content` (from `@google/genai` package)
- Represents the conversation or interaction data
- Typically contains `Parts` (text, images, etc.)

#### author (optional)

Identifies who created/authored the memory.

- Type: `string`
- Could be agent name, `'user'`, or other identifier
- Helps attribute memories to specific participants

#### timestamp (optional)

When the original content happened.

- Type: `string`
- Preferred format: ISO 8601 (e.g., `"2025-01-15T10:30:00Z"`)
- Will be forwarded to the LLM for temporal context
- Helps LLM understand temporal relationships

### Relationship to Session Data

`MemoryEntry` is derived from session events:

```typescript
// InMemoryMemoryService.addSessionToMemory()
const eventsWithContent = session.events.filter(
  (event) => (event.content?.parts?.length ?? 0) > 0
);

// Store for later search
```

When searching:

```typescript
// Match found, create MemoryEntry
const memory: MemoryEntry = {
  content: event.content,
  author: event.author,
  timestamp: formatTimestamp(event.timestamp),
};
```

### Usage in Agent Context

Memory entries enable the LLM to receive relevant past interactions with full context about who said what and when:

```typescript
const memories = await memoryService.searchMemory({
  appName: 'myApp',
  userId: 'user123',
  query: 'pizza preferences',
});

// Add memories to LLM context
llmRequest.contents.unshift(...memories.map(m => m.content));
```

## InMemoryMemoryService

`InMemoryMemoryService` provides simple keyword-based memory search for prototyping.

### Storage Structure

```typescript
export class InMemoryMemoryService implements BaseMemoryService {
  private readonly memories: MemoryEntry[] = [];  // Currently unused
  private readonly sessionEvents: {
    [userKey: string]: {[sessionId: string]: Event[]};
  } = {};
}
```

**Storage format:**
- Two-level nested map
- First level: `userKey` (constructed as `"appName/userId"`)
- Second level: `sessionId`
- Values: Array of Events with non-empty content

### Session Ingestion

```typescript
async addSessionToMemory(session: Session): Promise<void> {
  const userKey = getUserKey(session.appName, session.userId);
  if (!this.sessionEvents[userKey]) {
    this.sessionEvents[userKey] = {};
  }

  // Filter to events with content
  this.sessionEvents[userKey][session.id] = session.events.filter(
    (event) => (event.content?.parts?.length ?? 0) > 0,
  );
}

function getUserKey(appName: string, userId: string): string {
  return `${appName}/${userId}`;
}
```

**Process:**
1. Constructs `userKey` from `appName` and `userId`
2. Initializes nested structure if needed
3. Stores only events that have parts (non-empty content)
4. Indexed by `appName`/`userId`/`sessionId`

### Simple Text-Based Search

The search algorithm uses basic keyword matching:

```typescript
async searchMemory(req: SearchMemoryRequest): Promise<SearchMemoryResponse> {
  const userKey = getUserKey(req.appName, req.userId);
  if (!this.sessionEvents[userKey]) {
    return Promise.resolve({memories: []});
  }

  // Split query into lowercase words
  const wordsInQuery = req.query.toLowerCase().split(/\s+/);
  const response: SearchMemoryResponse = {memories: []};

  // Iterate through all sessions for this user
  for (const sessionEvents of Object.values(this.sessionEvents[userKey])) {
    for (const event of sessionEvents) {
      // Join all text parts
      const joinedText = event.content.parts
        .map((part) => part.text)
        .filter((text) => !!text)
        .join(' ');

      // Extract words from event
      const wordsInEvent = extractWordsLower(joinedText);

      // Check if ANY query word exists in event words
      const matchQuery = wordsInQuery.some((queryWord) =>
        wordsInEvent.has(queryWord)
      );

      if (matchQuery) {
        response.memories.push({
          content: event.content,
          author: event.author,
          timestamp: formatTimestamp(event.timestamp),
        });
      }
    }
  }

  return response;
}
```

**Helper Functions:**

```typescript
function extractWordsLower(text: string): Set<string> {
  const words = text.match(/[A-Za-z]+/g) || [];
  return new Set(words.map(w => w.toLowerCase()));
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
```

**Algorithm:**
1. Constructs `userKey` from `appName` and `userId`
2. Returns empty array if no sessions found
3. Splits query into lowercase words: `query.toLowerCase().split(/\s+/)`
4. Iterates through all sessions for that user
5. For each event with content parts:
   - Joins all text parts into single string
   - Extracts words using regex: `/[A-Za-z]+/` and converts to lowercase
   - Checks if ANY query word exists in event words (simple keyword match)
   - If match found, creates `MemoryEntry` and adds to results
6. Returns `SearchMemoryResponse` with all matching memories

### Limitations

This implementation is intended for prototyping only:

- **No semantic search** - Just keyword matching
- **No ranking** - No relevance scoring
- **No pagination** - Returns all matches
- **Limited scalability** - Stores all events in memory
- **Basic word extraction** - Simple regex, no stemming or lemmatization

**Production systems should use vector databases** for semantic search.

## ToolContext.searchMemory()

Tools can query the memory service through `ToolContext.searchMemory()`.

```typescript
searchMemory(query: string): Promise<SearchMemoryResponse>
```

### Implementation

```typescript
searchMemory(query: string): Promise<SearchMemoryResponse> {
  if (!this.invocationContext.memoryService) {
    throw new Error('Memory service is not initialized.');
  }

  return this.invocationContext.memoryService.searchMemory({
    appName: this.invocationContext.session.appName,
    userId: this.invocationContext.session.userId,
    query,
  });
}
```

**Process:**
1. **Validation**: Checks if `memoryService` is initialized on `invocationContext`
   - Throws `Error('Memory service is not initialized.')` if not available

2. **Request Construction**: Builds `SearchMemoryRequest` from:
   - `appName` from `invocationContext.session.appName`
   - `userId` from `invocationContext.session.userId`
   - `query` from the method parameter

3. **Service Call**: Forwards to `memoryService.searchMemory(request)`

4. **Return**: Returns `Promise<SearchMemoryResponse>` containing `memories: MemoryEntry[]`

### Use Cases for Tools

- Retrieve relevant information from past conversations
- Provide context about user preferences or history
- Enable tools to make more informed decisions based on past interactions
- Support RAG (Retrieval Augmented Generation) patterns

### Access Scope

- **Scoped to current appName and userId**
- Tools can only search memories for the current user
- Cross-user memory access is not allowed
- Search is session-independent (searches across all sessions for the user)

### Example Tool

```typescript
import {FunctionTool, ToolContext} from '@google/adk';
import {z} from 'zod';

const searchHistoryTool = new FunctionTool({
  name: 'search_history',
  description: 'Search conversation history for relevant information',
  parameters: z.object({
    query: z.string().describe('What to search for'),
  }),
  execute: async (args, context: ToolContext) => {
    const response = await context.searchMemory(args.query);

    if (response.memories.length === 0) {
      return {
        found: false,
        message: `No relevant history found for "${args.query}"`,
      };
    }

    // Format memories for display
    const results = response.memories.map((m, i) => ({
      index: i + 1,
      author: m.author || 'unknown',
      timestamp: m.timestamp || 'unknown',
      content: m.content.parts.map(p => p.text).join(' ').substring(0, 200),
    }));

    return {
      found: true,
      count: results.length,
      results,
    };
  },
});
```

## Custom Memory Service Implementation

To implement a custom memory service backed by a vector database, implement the `BaseMemoryService` interface.

### Implementation Steps

#### 1. Create Your Service Class

```typescript
import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
  MemoryEntry,
} from '@google/adk';

export class VectorMemoryService implements BaseMemoryService {
  private vectorDb: YourVectorDatabase;

  constructor(connectionConfig: VectorDbConfig) {
    this.vectorDb = new YourVectorDatabase(connectionConfig);
  }
}
```

#### 2. Implement addSessionToMemory()

Extract meaningful content, generate embeddings, and store in vector database:

```typescript
async addSessionToMemory(session: Session): Promise<void> {
  // Filter events with content
  const eventsWithContent = session.events.filter(
    (event) => (event.content?.parts?.length ?? 0) > 0
  );

  // For each event, create embeddings and store
  for (const event of eventsWithContent) {
    const text = event.content.parts
      .map(part => part.text)
      .filter(t => t)
      .join(' ');

    // Generate embedding (use your embedding service)
    const embedding = await this.generateEmbedding(text);

    // Store in vector DB with metadata
    await this.vectorDb.upsert({
      id: `${session.id}-${event.id}`,
      embedding: embedding,
      metadata: {
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
        author: event.author,
        timestamp: event.timestamp,
        content: event.content,
      },
    });
  }
}

private async generateEmbedding(text: string): Promise<number[]> {
  // Use embedding model (e.g., text-embedding-004)
  const response = await fetch('https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GOOGLE_API_KEY!,
    },
    body: JSON.stringify({
      content: {parts: [{text}]},
    }),
  });

  const data = await response.json();
  return data.embedding.values;
}
```

#### 3. Implement searchMemory()

Generate query embedding, perform vector similarity search, and return results:

```typescript
async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
  // Generate query embedding
  const queryEmbedding = await this.generateEmbedding(request.query);

  // Search vector database
  const results = await this.vectorDb.search({
    embedding: queryEmbedding,
    filter: {
      appName: request.appName,
      userId: request.userId,
    },
    topK: 10,  // Return top 10 matches
    minScore: 0.7,  // Minimum similarity threshold
  });

  // Convert to MemoryEntry format
  const memories: MemoryEntry[] = results.map(result => ({
    content: result.metadata.content,
    author: result.metadata.author,
    timestamp: new Date(result.metadata.timestamp).toISOString(),
  }));

  return {memories};
}
```

#### 4. Use in Runner

```typescript
const memoryService = new VectorMemoryService({
  apiKey: process.env.VECTOR_DB_KEY,
  index: 'agent-memories',
});

const runner = new Runner({
  agent: myAgent,
  sessionService: sessionService,
  memoryService: memoryService,  // Your custom service
});
```

### Popular Vector Database Options

- **Pinecone** - Managed vector database
- **Weaviate** - Open-source vector database
- **Qdrant** - High-performance vector search engine
- **Chroma** - AI-native embedding database
- **Google Vertex AI Vector Search** - GCP managed service
- **PostgreSQL with pgvector** - SQL database with vector extension

### Example with Pinecone

```typescript
import {Pinecone} from '@pinecone-database/pinecone';
import {BaseMemoryService} from '@google/adk';

export class PineconeMemoryService implements BaseMemoryService {
  private pinecone: Pinecone;
  private index: any;

  constructor(apiKey: string, indexName: string) {
    this.pinecone = new Pinecone({apiKey});
    this.index = this.pinecone.index(indexName);
  }

  async addSessionToMemory(session: Session): Promise<void> {
    const vectors = [];

    for (const event of session.events) {
      if ((event.content?.parts?.length ?? 0) === 0) continue;

      const text = event.content.parts
        .map(p => p.text)
        .filter(t => t)
        .join(' ');

      const embedding = await this.generateEmbedding(text);

      vectors.push({
        id: `${session.id}-${event.id}`,
        values: embedding,
        metadata: {
          appName: session.appName,
          userId: session.userId,
          sessionId: session.id,
          author: event.author,
          timestamp: event.timestamp,
          text,
        },
      });
    }

    if (vectors.length > 0) {
      await this.index.upsert(vectors);
    }
  }

  async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const queryEmbedding = await this.generateEmbedding(request.query);

    const results = await this.index.query({
      vector: queryEmbedding,
      filter: {
        appName: {$eq: request.appName},
        userId: {$eq: request.userId},
      },
      topK: 10,
      includeMetadata: true,
    });

    const memories: MemoryEntry[] = results.matches.map((match: any) => ({
      content: {
        role: match.metadata.author === 'user' ? 'user' : 'model',
        parts: [{text: match.metadata.text}],
      },
      author: match.metadata.author,
      timestamp: new Date(match.metadata.timestamp).toISOString(),
    }));

    return {memories};
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    // Implementation from above
    // ...
  }
}
```

## Complete Example

```typescript
import {
  Runner,
  InMemoryMemoryService,
  LlmAgent,
  FunctionTool,
  InMemorySessionService,
} from '@google/adk';
import {z} from 'zod';

// Setup memory service
const memoryService = new InMemoryMemoryService();

// Create a tool that searches memory
const searchHistoryTool = new FunctionTool({
  name: 'search_history',
  description: 'Search conversation history',
  parameters: z.object({
    query: z.string(),
  }),
  execute: async (args, context) => {
    const response = await context.searchMemory(args.query);
    return {
      count: response.memories.length,
      results: response.memories.map((m, i) => ({
        index: i + 1,
        author: m.author,
        time: m.timestamp,
        preview: m.content.parts[0]?.text?.substring(0, 100),
      })),
    };
  },
});

// Create agent with memory search capability
const agent = new LlmAgent({
  name: 'memory_agent',
  model: 'gemini-2.0-flash-exp',
  instruction: 'You can search conversation history using the search_history tool.',
  tools: [searchHistoryTool],
});

// Create runner with memory service
const sessionService = new InMemorySessionService();
const runner = new Runner({
  appName: 'myApp',
  agent: agent,
  sessionService: sessionService,
  memoryService: memoryService,
});

// Run multiple sessions to build memory
async function runConversations() {
  // Session 1: User orders pizza
  const session1 = await sessionService.getOrCreateSession({
    appName: 'myApp',
    userId: 'user123',
    sessionId: 'session1',
  });

  for await (const event of runner.runAsync({
    userId: 'user123',
    sessionId: session1.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'I would like to order a large pepperoni pizza'}],
    },
  })) {
    // Process events
  }

  // Add session to memory
  const finalSession1 = await sessionService.getSession({
    appName: 'myApp',
    userId: 'user123',
    sessionId: session1.id,
  });
  await memoryService.addSessionToMemory(finalSession1);

  // Session 2: Query about past orders
  const session2 = await sessionService.getOrCreateSession({
    appName: 'myApp',
    userId: 'user123',
    sessionId: 'session2',
  });

  for await (const event of runner.runAsync({
    userId: 'user123',
    sessionId: session2.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'What kind of pizza did I order before?'}],
    },
  })) {
    console.log(event);
    // Agent will use searchHistoryTool to find "pepperoni pizza"
  }
}

runConversations();
```

## Best Practices

1. **Index sessions after they complete**: Add sessions to memory after they're finished, not during active conversation
2. **Filter meaningful content**: Only index events with actual content (non-empty parts)
3. **Use semantic search for production**: Vector databases provide better search quality than keyword matching
4. **Scope memories appropriately**: Enforce user-level isolation for privacy
5. **Set relevance thresholds**: Use similarity scores to filter low-quality matches
6. **Limit result count**: Return top-K results to avoid overwhelming the LLM
7. **Include temporal context**: Preserve timestamps to help LLM understand temporal relationships
8. **Handle empty results**: Gracefully handle cases where no relevant memories are found

## See Also

- [Sessions](./sessions.md) - Session structure and management
- [Tools](./tools.md) - Tool context and memory search
- [Agents](./agents.md) - Agent configuration and context
