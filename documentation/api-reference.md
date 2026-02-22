# API Reference

The ADK development server exposes a comprehensive REST API for managing sessions, artifacts, and agent execution. This API is available when running `npx @google/adk-devtools web` or `npx @google/adk-devtools api_server`.

## Base URL

```
http://localhost:8000
```

The host and port can be configured via CLI options:
```bash
npx @google/adk-devtools web --host 0.0.0.0 --port 3000
```

## CORS Configuration

CORS is disabled by default. Enable it with the `--allow_origins` option:

```bash
npx @google/adk-devtools web --allow_origins "http://localhost:3000"
```

For multiple origins, separate with commas:
```bash
--allow_origins "http://localhost:3000,http://localhost:3001"
```

## Authentication

The development server does not require authentication. For production deployments, implement authentication at the infrastructure level (e.g., Cloud Run with IAM, API Gateway with API keys).

## Request/Response Format

All endpoints accept and return JSON with `Content-Type: application/json`.

Request body limit: **50MB**

## Error Handling

Error responses follow this format:

```json
{
  "error": "Error message describing what went wrong"
}
```

Common HTTP status codes:
- `400` - Bad request (e.g., session already exists)
- `404` - Resource not found
- `500` - Internal server error
- `501` - Not implemented (eval endpoints)

## Discovery Endpoints

### List Applications

List all available agents discovered by the AgentLoader.

**Endpoint:** `GET /list-apps`

**Response:**
```json
[
  "customer_support",
  "sales_assistant",
  "analytics_agent"
]
```

The list contains agent names that can be used in the `appName` parameter of other endpoints.

**Example:**
```bash
curl http://localhost:8000/list-apps
```

## Session Endpoints

Sessions maintain conversation state and event history for agent interactions.

### Create Session

Create a new session with an auto-generated or specified ID.

**Endpoint:** `POST /apps/:appName/users/:userId/sessions`

**Path Parameters:**
- `appName` - Agent name (from `/list-apps`)
- `userId` - User identifier

**Request Body:**
```json
{
  "state": {
    "user_tier": "premium",
    "preferences": {
      "language": "en"
    }
  }
}
```

**Response:**
```json
{
  "id": "uuid-generated-session-id",
  "appName": "customer_support",
  "userId": "user_123",
  "state": {
    "user_tier": "premium",
    "preferences": {
      "language": "en"
    }
  },
  "events": [],
  "lastUpdateTime": 0
}
```

**Example:**
```bash
curl -X POST http://localhost:8000/apps/my_agent/users/user_123/sessions \
  -H "Content-Type: application/json" \
  -d '{"state": {"user_name": "Alice"}}'
```

### Create Session with ID

Create a session with a specific ID.

**Endpoint:** `POST /apps/:appName/users/:userId/sessions/:sessionId`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Desired session ID

**Request Body:**
```json
{
  "state": {
    "context": "initial_setup"
  }
}
```

**Response:**
```json
{
  "id": "my-custom-session-id",
  "appName": "my_agent",
  "userId": "user_123",
  "state": {
    "context": "initial_setup"
  },
  "events": [],
  "lastUpdateTime": 0
}
```

**Error Response (409):**
If session already exists:
```json
{
  "error": "Session already exists: my-custom-session-id"
}
```

**Example:**
```bash
curl -X POST http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc \
  -H "Content-Type: application/json" \
  -d '{"state": {}}'
```

### Get Session

Retrieve a session with its events and state.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions/:sessionId`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID

**Response:**
```json
{
  "id": "session_abc",
  "appName": "my_agent",
  "userId": "user_123",
  "state": {
    "user_name": "Alice",
    "conversation_count": 5
  },
  "events": [
    {
      "id": "event_1",
      "author": "user",
      "timestamp": 1234567890000,
      "content": {
        "role": "user",
        "parts": [{"text": "Hello"}]
      }
    },
    {
      "id": "event_2",
      "author": "my_agent",
      "timestamp": 1234567891000,
      "content": {
        "role": "model",
        "parts": [{"text": "Hello! How can I help you?"}]
      }
    }
  ],
  "lastUpdateTime": 1234567891000
}
```

**Error Response (404):**
```json
{
  "error": "Session not found: session_abc"
}
```

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc
```

### List Sessions

List all sessions for a specific user and app.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier

**Response:**
```json
[
  {
    "id": "session_1",
    "appName": "my_agent",
    "userId": "user_123",
    "lastUpdateTime": 1234567890000
  },
  {
    "id": "session_2",
    "appName": "my_agent",
    "userId": "user_123",
    "lastUpdateTime": 1234567895000
  }
]
```

Note: Events and full state are not included in list responses.

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions
```

### Delete Session

Delete a session and all its events.

**Endpoint:** `DELETE /apps/:appName/users/:userId/sessions/:sessionId`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID

**Response:**
```
204 No Content
```

**Error Response (404):**
```json
{
  "error": "Session not found: session_abc"
}
```

**Example:**
```bash
curl -X DELETE http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc
```

## Artifact Endpoints

Artifacts are files associated with a session (e.g., generated documents, images, data files).

### Get Artifact

Retrieve the latest version of an artifact.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID
- `artifactName` - Artifact filename

**Response:**
```json
{
  "filename": "report.pdf",
  "content": "base64-encoded-content",
  "mimeType": "application/pdf",
  "version": 3,
  "timestamp": 1234567890000
}
```

**Error Response (404):**
```json
{
  "error": "Artifact not found: report.pdf"
}
```

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/artifacts/report.pdf
```

### Get Artifact Version

Retrieve a specific version of an artifact.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions/:versionId`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID
- `artifactName` - Artifact filename
- `versionId` - Version number (integer)

**Response:**
```json
{
  "filename": "report.pdf",
  "content": "base64-encoded-content",
  "mimeType": "application/pdf",
  "version": 1,
  "timestamp": 1234567880000
}
```

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/artifacts/report.pdf/versions/1
```

### List Artifact Keys

List all artifact filenames for a session.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions/:sessionId/artifacts`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID

**Response:**
```json
[
  "report.pdf",
  "chart.png",
  "data.json"
]
```

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/artifacts
```

### List Artifact Versions

List all versions of a specific artifact.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID
- `artifactName` - Artifact filename

**Response:**
```json
[
  {
    "version": 1,
    "timestamp": 1234567880000
  },
  {
    "version": 2,
    "timestamp": 1234567885000
  },
  {
    "version": 3,
    "timestamp": 1234567890000
  }
]
```

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/artifacts/report.pdf/versions
```

### Delete Artifact

Delete all versions of an artifact.

**Endpoint:** `DELETE /apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID
- `artifactName` - Artifact filename

**Response:**
```
204 No Content
```

**Example:**
```bash
curl -X DELETE http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/artifacts/report.pdf
```

## Execution Endpoints

### Run Agent

Execute an agent with a new message and return all events.

**Endpoint:** `POST /run`

**Request Body:**
```json
{
  "appName": "my_agent",
  "userId": "user_123",
  "sessionId": "session_abc",
  "newMessage": {
    "role": "user",
    "parts": [
      {
        "text": "What is the weather today?"
      }
    ]
  },
  "stateDelta": {
    "location": "San Francisco"
  }
}
```

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `appName` | string | Yes | Agent name |
| `userId` | string | Yes | User identifier |
| `sessionId` | string | Yes | Session ID |
| `newMessage` | Content | Yes | User message |
| `stateDelta` | object | No | State updates to apply |

**Response:**

Array of all events generated during the run:

```json
[
  {
    "id": "event_1",
    "author": "user",
    "timestamp": 1234567890000,
    "content": {
      "role": "user",
      "parts": [{"text": "What is the weather today?"}]
    },
    "actions": {
      "stateDelta": {
        "location": "San Francisco"
      }
    }
  },
  {
    "id": "event_2",
    "author": "my_agent",
    "timestamp": 1234567890100,
    "content": {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "name": "get_weather",
            "args": {"location": "San Francisco"}
          }
        }
      ]
    }
  },
  {
    "id": "event_3",
    "author": "get_weather",
    "timestamp": 1234567890200,
    "content": {
      "role": "function",
      "parts": [
        {
          "functionResponse": {
            "name": "get_weather",
            "response": {"temperature": 72, "condition": "sunny"}
          }
        }
      ]
    }
  },
  {
    "id": "event_4",
    "author": "my_agent",
    "timestamp": 1234567890300,
    "content": {
      "role": "model",
      "parts": [
        {
          "text": "The weather in San Francisco is 72°F and sunny."
        }
      ]
    }
  }
]
```

**Error Response (404):**
```json
{
  "error": "Session not found: session_abc"
}
```

**Example:**
```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{
    "appName": "my_agent",
    "userId": "user_123",
    "sessionId": "session_abc",
    "newMessage": {
      "role": "user",
      "parts": [{"text": "Hello"}]
    }
  }'
```

### Run Agent with SSE Streaming

Execute an agent and stream events via Server-Sent Events (SSE).

**Endpoint:** `POST /run_sse`

**Request Body:**
```json
{
  "appName": "my_agent",
  "userId": "user_123",
  "sessionId": "session_abc",
  "newMessage": {
    "role": "user",
    "parts": [{"text": "Tell me a story"}]
  },
  "streaming": true,
  "stateDelta": {}
}
```

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `appName` | string | Yes | Agent name |
| `userId` | string | Yes | User identifier |
| `sessionId` | string | Yes | Session ID |
| `newMessage` | Content | Yes | User message |
| `streaming` | boolean | No | Enable SSE streaming mode (default: false) |
| `stateDelta` | object | No | State updates to apply |

**Response Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Access-Control-Allow-Origin: *
Connection: keep-alive
```

**Response Stream:**

Each event is sent as:
```
data: {"id":"event_1","author":"user",...}

data: {"id":"event_2","author":"my_agent","partial":true,...}

data: {"id":"event_2","author":"my_agent","partial":true,...}

data: {"id":"event_2","author":"my_agent",...}

data: {"id":"event_3","author":"my_agent",...}

```

**Streaming Behavior:**

When `streaming: true`:
- Events with `"partial": true` are intermediate streaming chunks
- Only final events (without `partial` flag) are persisted to the session
- Allows real-time display of LLM responses as they generate

When `streaming: false` or omitted:
- Events are emitted only when complete
- All events are persisted to the session

**Example (JavaScript):**

```javascript
const eventSource = new EventSource('http://localhost:8000');

fetch('http://localhost:8000/run_sse', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    appName: 'my_agent',
    userId: 'user_123',
    sessionId: 'session_abc',
    newMessage: {
      role: 'user',
      parts: [{text: 'Hello'}]
    },
    streaming: true
  })
}).then(async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const {done, value} = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6));
        console.log('Event:', event);
      }
    }
  }
});
```

**Example (curl):**

```bash
curl -X POST http://localhost:8000/run_sse \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "appName": "my_agent",
    "userId": "user_123",
    "sessionId": "session_abc",
    "newMessage": {
      "role": "user",
      "parts": [{"text": "Hello"}]
    },
    "streaming": true
  }'
```

## Debug Endpoints

These endpoints provide access to OpenTelemetry traces for debugging.

### Get Event Trace

Retrieve OpenTelemetry span attributes for a specific event.

**Endpoint:** `GET /debug/trace/:eventId`

**Path Parameters:**
- `eventId` - Event ID

**Response:**
```json
{
  "trace_id": "abc123...",
  "span_id": "def456...",
  "gen_ai.operation.name": "call_llm",
  "gen_ai.request.model": "gemini-2.5-flash",
  "gen_ai.usage.input_tokens": 150,
  "gen_ai.usage.output_tokens": 200,
  "gcp.vertex.agent.invocation_id": "inv_123",
  "gcp.vertex.agent.session_id": "session_abc",
  "gcp.vertex.agent.event_id": "event_2",
  "gcp.vertex.agent.llm_request": "{...}",
  "gcp.vertex.agent.llm_response": "{...}"
}
```

**Error Response (404):**
```json
{
  "error": "Trace not found"
}
```

**Example:**
```bash
curl http://localhost:8000/debug/trace/event_2
```

### Get Session Traces

Retrieve all OpenTelemetry spans for a session.

**Endpoint:** `GET /debug/trace/session/:sessionId`

**Path Parameters:**
- `sessionId` - Session ID

**Response:**
```json
[
  {
    "name": "call_llm",
    "span_id": "span_1",
    "trace_id": "trace_abc",
    "start_time": 1234567890000000000,
    "end_time": 1234567890500000000,
    "attributes": {
      "gen_ai.operation.name": "call_llm",
      "gen_ai.request.model": "gemini-2.5-flash",
      "gcp.vertex.agent.session_id": "session_abc"
    },
    "parent_span_id": null
  },
  {
    "name": "execute_tool",
    "span_id": "span_2",
    "trace_id": "trace_abc",
    "start_time": 1234567890600000000,
    "end_time": 1234567890800000000,
    "attributes": {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_weather",
      "gcp.vertex.agent.session_id": "session_abc"
    },
    "parent_span_id": "span_1"
  }
]
```

**Time Format:**
- `start_time` and `end_time` are in nanoseconds
- Use `hrTimeToNanoseconds()` utility to convert OpenTelemetry HrTime

**Example:**
```bash
curl http://localhost:8000/debug/trace/session/session_abc
```

### Get Agent Graph

Retrieve the agent graph in DOT format for visualization.

**Endpoint:** `GET /apps/:appName/users/:userId/sessions/:sessionId/events/:eventId/graph`

**Path Parameters:**
- `appName` - Agent name
- `userId` - User identifier
- `sessionId` - Session ID
- `eventId` - Event ID

**Response:**
```json
{
  "dotSrc": "digraph G {\n  user -> my_agent;\n  my_agent -> get_weather;\n  get_weather -> my_agent;\n  my_agent -> user;\n}"
}
```

The DOT format graph can be visualized with Graphviz or similar tools. It highlights the flow between:
- User
- Agents
- Tools

**Highlights:**
- Function calls are shown as edges from agent to tool
- Function responses are shown as edges from tool to agent
- Final responses are edges to the target (user or parent agent)

**Example:**
```bash
curl http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/events/event_2/graph
```

**Visualize with Graphviz:**
```bash
curl -s http://localhost:8000/apps/my_agent/users/user_123/sessions/session_abc/events/event_2/graph \
  | jq -r '.dotSrc' \
  | dot -Tpng -o graph.png
```

## Evaluation Endpoints (Not Implemented)

The following endpoints return `501 Not Implemented`:

### Eval Sets

- `POST /apps/:appName/eval_sets/:evalSetId` - Create eval set
- `GET /apps/:appName/eval_sets` - List eval sets
- `POST /apps/:appName/eval_sets/:evalSetId/add_session` - Add session to eval set
- `GET /apps/:appName/eval_sets/:evalSetId/evals` - List eval cases
- `GET /apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId` - Get eval case
- `PUT /apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId` - Update eval case
- `DELETE /apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId` - Delete eval case
- `POST /apps/:appName/eval_sets/:evalSetId/run_eval` - Run evaluation

### Eval Results

- `GET /apps/:appName/eval_results/:evalResultId` - Get eval result
- `GET /apps/:appName/eval_results` - List eval results
- `GET /apps/:appName/eval_metrics` - Get eval metrics

These endpoints are placeholders for future evaluation functionality.

## Server Configuration

### ServerOptions

The `AdkWebServer` class accepts these configuration options:

```typescript
interface ServerOptions {
  agentsDir?: string;           // Agent file or directory path
  host?: string;                // Binding host (default: localhost)
  port?: number;                // Server port (default: 8000)
  sessionService?: BaseSessionService;  // Session storage backend
  memoryService?: BaseMemoryService;    // Memory storage backend
  artifactService?: BaseArtifactService; // Artifact storage backend
  agentLoader?: AgentLoader;    // Custom agent loader
  agentFileLoadOptions?: AgentFileOptions; // Compile/bundle options
  serveDebugUI?: boolean;       // Serve Angular debug UI (default: false)
  allowOrigins?: string;        // CORS allowed origins
  otelToCloud?: boolean;        // Export telemetry to GCP (default: false)
  registerProcessors?: (tracerProvider: TracerProvider) => void; // Custom OTel setup
}
```

**Example:**

```typescript
import {
  AdkWebServer,
  InMemorySessionService,
  InMemoryArtifactService,
  AgentLoader
} from '@google/adk-devtools';

const server = new AdkWebServer({
  agentsDir: './agents',
  host: '0.0.0.0',
  port: 8080,
  serveDebugUI: true,
  allowOrigins: 'http://localhost:3000',
  sessionService: new InMemorySessionService(),
  artifactService: new InMemoryArtifactService(),
  otelToCloud: true
});

await server.start();
```

## Runner Caching

The server maintains a runner cache to avoid recreating Runner instances for each request:

```typescript
private runnerCache: Record<string, Runner> = {};
```

**Behavior:**
- First request for an app creates a new `Runner`
- Subsequent requests reuse the cached `Runner`
- Cache is per `appName`
- Cache persists for the server lifetime

**Benefits:**
- Faster request handling
- Consistent plugin state
- Reduced memory allocations

**Note:** The cache is in-memory only. Restarting the server clears the cache.

## Complete API Examples

### Create Session and Run Agent

```bash
# 1. Create session
SESSION_ID=$(curl -s -X POST http://localhost:8000/apps/my_agent/users/alice/sessions \
  -H "Content-Type: application/json" \
  -d '{"state": {"user_tier": "premium"}}' \
  | jq -r '.id')

echo "Created session: $SESSION_ID"

# 2. Run agent
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d "{
    \"appName\": \"my_agent\",
    \"userId\": \"alice\",
    \"sessionId\": \"$SESSION_ID\",
    \"newMessage\": {
      \"role\": \"user\",
      \"parts\": [{\"text\": \"Hello\"}]
    }
  }" | jq '.'

# 3. Get session with events
curl http://localhost:8000/apps/my_agent/users/alice/sessions/$SESSION_ID | jq '.'

# 4. Get traces
curl http://localhost:8000/debug/trace/session/$SESSION_ID | jq '.'
```

### Stream Response with SSE

```javascript
async function runAgentWithStreaming() {
  const response = await fetch('http://localhost:8000/run_sse', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      appName: 'my_agent',
      userId: 'alice',
      sessionId: 'session_123',
      newMessage: {
        role: 'user',
        parts: [{text: 'Write a short story'}]
      },
      streaming: true
    })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const {done, value} = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6));

        if (event.content?.parts) {
          for (const part of event.content.parts) {
            if (part.text) {
              process.stdout.write(part.text);
            }
          }
        }
      }
    }
  }
}

runAgentWithStreaming();
```

### Manage Artifacts

```bash
# List artifacts
curl http://localhost:8000/apps/my_agent/users/alice/sessions/session_123/artifacts

# Get artifact
curl http://localhost:8000/apps/my_agent/users/alice/sessions/session_123/artifacts/report.pdf \
  | jq -r '.content' | base64 -d > report.pdf

# List artifact versions
curl http://localhost:8000/apps/my_agent/users/alice/sessions/session_123/artifacts/report.pdf/versions

# Get specific version
curl http://localhost:8000/apps/my_agent/users/alice/sessions/session_123/artifacts/report.pdf/versions/1

# Delete artifact
curl -X DELETE http://localhost:8000/apps/my_agent/users/alice/sessions/session_123/artifacts/report.pdf
```

## Related Documentation

- [CLI](./cli.md) - CLI commands for starting the server
- [Runner](./runner.md) - Execution orchestration
- [Sessions](./sessions.md) - Session management
- [Artifacts](./artifacts.md) - Artifact storage
- [Telemetry](./telemetry.md) - OpenTelemetry integration
- [Events](./events.md) - Event structure and types
