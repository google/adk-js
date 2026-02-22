# Sessions

Sessions manage conversation state, event history, and user context in ADK-JS applications. The session system provides persistent storage for multi-turn interactions and state management with scoping prefixes.

## Table of Contents

- [Session Interface](#session-interface)
- [State Class](#state-class)
- [BaseSessionService](#basesessionservice)
- [InMemorySessionService](#inmemoryessionservice)
- [Session Service Registry](#session-service-registry)
- [StateDelta Flow](#statedelta-flow)

## Session Interface

The `Session` interface represents a conversation session between a user and an agent application.

### Structure

```typescript
interface Session {
  id: string;                        // Unique session identifier
  appName: string;                   // Application name
  userId: string;                    // User identifier
  state: Record<string, unknown>;    // Current session state
  events: Event[];                   // Conversation event history
  lastUpdateTime: number;            // Timestamp of last update
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier, auto-generated if not provided |
| `appName` | `string` | Name of the agent application |
| `userId` | `string` | User identifier (defaults to empty string) |
| `state` | `Record<string, unknown>` | Key-value state storage |
| `events` | `Event[]` | Chronological list of conversation events |
| `lastUpdateTime` | `number` | Unix timestamp (milliseconds) of last modification |

### Creating Sessions

```typescript
import { BaseSessionService } from '@google/adk';

const session = await sessionService.createSession({
  appName: 'my-agent',
  userId: 'user-123',
  state: {
    'app:config': { theme: 'dark' },
    'user:preferences': { language: 'en' }
  },
  sessionId: 'optional-custom-id'  // Auto-generated if omitted
});
```

### Session Lifecycle

```
1. Create → createSession()
   ├─ Generate ID (if not provided)
   ├─ Initialize state = {}
   ├─ Initialize events = []
   └─ Set lastUpdateTime = Date.now()

2. Use → getSession() / getOrCreateSession()
   ├─ Retrieve by appName + userId + sessionId
   └─ Apply filters (numRecentEvents, afterTimestamp)

3. Update → appendEvent()
   ├─ Add event to events[]
   ├─ Apply event.actions.stateDelta to state
   └─ Update lastUpdateTime

4. Delete → deleteSession()
   └─ Remove from storage
```

## State Class

The `State` class provides a dual-layer state management system with current values and pending deltas.

### Core Concept

```typescript
class State {
  constructor(
    private value: Record<string, unknown> = {},  // Current committed state
    private delta: Record<string, unknown> = {}   // Pending changes
  );
}
```

### State Prefixes

Three scoping prefixes control state persistence and visibility:

```typescript
static readonly APP_PREFIX = 'app:';   // Application-wide state
static readonly USER_PREFIX = 'user:'; // User-scoped state
static readonly TEMP_PREFIX = 'temp:'; // Temporary (not persisted)
```

| Prefix | Scope | Persisted | Use Case |
|--------|-------|-----------|----------|
| `app:` | Application | Yes | App-wide configuration, global settings |
| `user:` | User | Yes | User preferences, user-specific data |
| `temp:` | Session | No | Temporary working data, intermediate results |
| (none) | Session | Yes | Default session state |

### Methods

#### `get<T>(key: string, defaultValue?: T): T | undefined`

Retrieves state value, checking delta first, then value:

```typescript
const theme = state.get<string>('app:theme', 'light');
const userName = state.get<string>('user:name');
const tempData = state.get('temp:working_set');
```

**Lookup Order:**
1. Check `delta` (pending changes)
2. Check `value` (committed state)
3. Return `defaultValue` if not found

#### `set(key: string, value: unknown): void`

Sets state value in both `value` and `delta`:

```typescript
state.set('user:score', 100);
state.set('temp:cache', { data: [...] });
state.set('app:version', '1.2.3');
```

#### `has(key: string): boolean`

Checks if key exists in either `value` or `delta`:

```typescript
if (state.has('user:authenticated')) {
  // Key exists
}
```

#### `hasDelta(): boolean`

Returns true if there are pending changes:

```typescript
if (state.hasDelta()) {
  // Uncommitted changes exist
}
```

#### `update(delta: Record<string, unknown>): void`

Merges delta changes into both `delta` and `value`:

```typescript
state.update({
  'user:score': 150,
  'app:lastSync': Date.now()
});
```

#### `toRecord(): Record<string, unknown>`

Returns merged state as plain object:

```typescript
const stateSnapshot = state.toRecord();
// Contains both value and delta merged
```

### State Prefix Exclusion

The `TEMP_PREFIX` keys are excluded from persistence by `BaseSessionService.updateSessionState()`:

```typescript
protected updateSessionState(
  session: Session,
  eventActions: EventActions
): void {
  for (const [key, value] of Object.entries(eventActions.stateDelta)) {
    if (key.startsWith(State.TEMP_PREFIX)) {
      continue;  // Skip temp: prefixed keys
    }
    session.state[key] = value;
  }
}
```

### Usage Examples

```typescript
import { State } from '@google/adk';

const state = new State(
  { 'user:name': 'Alice', 'app:version': '1.0' },  // Initial value
  { 'temp:cache': [] }                              // Initial delta
);

// Read
const name = state.get<string>('user:name');        // 'Alice'
const cache = state.get('temp:cache');              // []

// Write
state.set('user:score', 100);

// Check changes
if (state.hasDelta()) {
  console.log('Uncommitted changes exist');
}

// Merge changes
state.update({
  'app:config': { theme: 'dark' },
  'temp:working': { step: 1 }
});

// Export
const snapshot = state.toRecord();
```

## BaseSessionService

Abstract base class defining the session service contract.

### Abstract Methods

```typescript
abstract class BaseSessionService {
  abstract createSession(request: CreateSessionRequest): Promise<Session>;
  abstract getSession(request: GetSessionRequest): Promise<Session | undefined>;
  abstract listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse>;
  abstract deleteSession(request: DeleteSessionRequest): Promise<void>;
}
```

### Request Interfaces

#### CreateSessionRequest

```typescript
interface CreateSessionRequest {
  appName: string;               // Application name (required)
  userId: string;                // User ID (required)
  state?: Record<string, unknown>; // Initial state (optional)
  sessionId?: string;            // Custom ID (auto-generated if omitted)
}
```

#### GetSessionRequest

```typescript
interface GetSessionRequest {
  appName: string;
  userId: string;
  sessionId: string;
  config?: GetSessionConfig;
}

interface GetSessionConfig {
  numRecentEvents?: number;     // Limit to last N events
  afterTimestamp?: number;      // Events after this timestamp
}
```

#### ListSessionsRequest

```typescript
interface ListSessionsRequest {
  appName: string;
  userId: string;
}
```

#### DeleteSessionRequest

```typescript
interface DeleteSessionRequest {
  appName: string;
  userId: string;
  sessionId: string;
}
```

### Non-Abstract Methods

#### `getOrCreateSession()`

Retrieves an existing session or creates a new one:

```typescript
async getOrCreateSession(request: CreateSessionRequest): Promise<Session> {
  if (!request.sessionId) {
    return this.createSession(request);
  }

  const session = await this.getSession({
    appName: request.appName,
    userId: request.userId,
    sessionId: request.sessionId
  });

  if (session) {
    return session;
  }

  return this.createSession(request);
}
```

**Usage:**

```typescript
// Auto-creates if sessionId not found
const session = await sessionService.getOrCreateSession({
  appName: 'my-agent',
  userId: 'user-123',
  sessionId: 'session-abc'  // Creates if doesn't exist
});
```

#### `appendEvent()`

Base implementation that appends events and applies state deltas:

```typescript
async appendEvent({session, event}: AppendEventRequest): Promise<Event> {
  // Skip partial events
  if (event.partial) {
    return event;
  }

  // Update state (excludes temp: prefix)
  this.updateSessionState(session, event.actions);

  // Append to event history
  session.events.push(event);

  return event;
}
```

### State Update Logic

```typescript
protected updateSessionState(
  session: Session,
  eventActions: EventActions
): void {
  for (const [key, value] of Object.entries(eventActions.stateDelta)) {
    // Skip temporary state
    if (key.startsWith(State.TEMP_PREFIX)) {
      continue;
    }

    // Apply to session state
    session.state[key] = value;
  }
}
```

**Key Points:**
- Partial events (`event.partial === true`) are NOT persisted
- Only final events update session state
- `temp:` prefixed keys are excluded from persistence
- State accumulates: each event's delta merges into `session.state`

## InMemorySessionService

In-memory implementation of `BaseSessionService` using nested JavaScript objects.

### Storage Structure

```typescript
class InMemorySessionService extends BaseSessionService {
  private sessions: Record<string, Record<string, Record<string, Session>>>;
  // Structure: appName -> userId -> sessionId -> Session

  private userState: Record<string, Record<string, Record<string, unknown>>>;
  // Structure: appName -> userId -> key -> value

  private appState: Record<string, Record<string, unknown>>;
  // Structure: appName -> key -> value
}
```

### Scoped State Storage

InMemorySessionService separates state by prefix:

- **Session state**: Stored in `Session.state` (no prefix or any prefix)
- **User state**: `user:` prefixed keys stored in `userState` dictionary
- **App state**: `app:` prefixed keys stored in `appState` dictionary
- **Temp state**: `temp:` prefixed keys never persisted

### Creating Sessions

```typescript
override async createSession(request: CreateSessionRequest): Promise<Session> {
  const sessionId = request.sessionId || randomUUID();

  const session = createSession({
    appName: request.appName,
    userId: request.userId,
    state: request.state || {},
    sessionId,
    events: [],
    lastUpdateTime: Date.now()
  });

  // Store in nested structure
  if (!this.sessions[request.appName]) {
    this.sessions[request.appName] = {};
  }
  if (!this.sessions[request.appName][request.userId]) {
    this.sessions[request.appName][request.userId] = {};
  }
  this.sessions[request.appName][request.userId][sessionId] = session;

  return session;
}
```

### GetSessionConfig Filtering

#### numRecentEvents

Limits returned events to the last N:

```typescript
if (config?.numRecentEvents) {
  session.events = session.events.slice(-config.numRecentEvents);
}
```

**Example:**

```typescript
const session = await sessionService.getSession({
  appName: 'my-agent',
  userId: 'user-123',
  sessionId: 'session-abc',
  config: { numRecentEvents: 10 }  // Only last 10 events
});
```

#### afterTimestamp

Returns events after a specific timestamp:

```typescript
if (config?.afterTimestamp) {
  // Find last event before timestamp
  let indexBeforeTimestamp = -1;
  for (let i = session.events.length - 1; i >= 0; i--) {
    if (session.events[i].timestamp <= config.afterTimestamp) {
      indexBeforeTimestamp = i;
      break;
    }
  }

  // Slice from that point
  session.events = session.events.slice(indexBeforeTimestamp + 1);
}
```

**Example:**

```typescript
const lastSync = 1640000000000;
const session = await sessionService.getSession({
  appName: 'my-agent',
  userId: 'user-123',
  sessionId: 'session-abc',
  config: { afterTimestamp: lastSync }  // Events after lastSync
});
```

### State Merging

`getSession()` returns a deep clone with merged state:

```typescript
override async getSession(request: GetSessionRequest): Promise<Session | undefined> {
  const session = this.sessions[request.appName]?.[request.userId]?.[request.sessionId];
  if (!session) return undefined;

  // Deep clone to prevent mutations
  const clonedSession = cloneDeep(session);

  // Apply event filters
  if (request.config?.numRecentEvents) {
    clonedSession.events = clonedSession.events.slice(-request.config.numRecentEvents);
  }
  if (request.config?.afterTimestamp) {
    // Filter events by timestamp
  }

  // Merge app and user state
  this.mergeState(clonedSession);

  return clonedSession;
}
```

### mergeState()

Merges app-scoped and user-scoped state back into session:

```typescript
private mergeState(session: Session): void {
  const appState = this.appState[session.appName] || {};
  const userState = this.userState[session.appName]?.[session.userId] || {};

  // Merge app state (app: prefixed keys)
  for (const [key, value] of Object.entries(appState)) {
    session.state[`app:${key}`] = value;
  }

  // Merge user state (user: prefixed keys)
  for (const [key, value] of Object.entries(userState)) {
    session.state[`user:${key}`] = value;
  }
}
```

### Appending Events

```typescript
override async appendEvent({session, event}: AppendEventRequest): Promise<Event> {
  if (event.partial) {
    return event;
  }

  // Process state delta with prefix separation
  for (const [key, value] of Object.entries(event.actions.stateDelta)) {
    if (key.startsWith(State.TEMP_PREFIX)) {
      continue;  // Skip temp state
    }

    if (key.startsWith(State.APP_PREFIX)) {
      // Store in app state
      const appKey = key.substring(State.APP_PREFIX.length);
      if (!this.appState[session.appName]) {
        this.appState[session.appName] = {};
      }
      this.appState[session.appName][appKey] = value;
    } else if (key.startsWith(State.USER_PREFIX)) {
      // Store in user state
      const userKey = key.substring(State.USER_PREFIX.length);
      if (!this.userState[session.appName]) {
        this.userState[session.appName] = {};
      }
      if (!this.userState[session.appName][session.userId]) {
        this.userState[session.appName][session.userId] = {};
      }
      this.userState[session.appName][session.userId][userKey] = value;
    } else {
      // Store in session state (no prefix)
      session.state[key] = value;
    }
  }

  // Update timestamp
  session.lastUpdateTime = Date.now();

  // Append event
  session.events.push(event);

  return event;
}
```

### Listing Sessions

Returns session metadata without events or state:

```typescript
override async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
  const sessions = this.sessions[request.appName]?.[request.userId];
  if (!sessions) {
    return { sessions: [] };
  }

  return {
    sessions: Object.values(sessions).map(session => ({
      id: session.id,
      appName: session.appName,
      userId: session.userId,
      state: {},        // Empty for list
      events: [],       // Empty for list
      lastUpdateTime: session.lastUpdateTime
    }))
  };
}
```

## Session Service Registry

Factory function for creating session services from URI strings.

### Usage

```typescript
import { getSessionServiceFromUri } from '@google/adk';

const sessionService = getSessionServiceFromUri('memory://');
```

### Supported URI Schemes

| URI | Service | Description |
|-----|---------|-------------|
| `memory://` | `InMemorySessionService` | In-memory storage (not persistent) |

### Implementation

```typescript
export function getSessionServiceFromUri(uri: string): BaseSessionService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemorySessionService();
  }

  throw new Error(`Unsupported session service URI: ${uri}`);
}

function isInMemoryConnectionString(uri: string): boolean {
  return uri === 'memory://';
}
```

### Future Extensions

The registry pattern allows adding new storage backends:

```typescript
// Future: Cloud storage
if (uri.startsWith('gs://')) {
  return new GcsSessionService(uri);
}

// Future: Database
if (uri.startsWith('postgres://')) {
  return new PostgresSessionService(uri);
}
```

## StateDelta Flow

Understanding how state changes flow through the system.

### Event Creation with StateDelta

```typescript
import { createEvent, createEventActions } from '@google/adk';

const event = createEvent({
  author: 'my-agent',
  actions: createEventActions({
    stateDelta: {
      'user:score': 100,
      'app:version': '1.2',
      'temp:cache': { data: [] }
    }
  })
});
```

### Runner Integration

The `Runner` passes user-provided `stateDelta` to session:

```typescript
// In runner.runAsync()
if (userStateDelta) {
  const userEvent = createEvent({
    author: 'user',
    actions: createEventActions({ stateDelta: userStateDelta })
  });

  await sessionService.appendEvent({
    session,
    event: userEvent
  });
}
```

**User API:**

```typescript
for await (const event of runner.runAsync({
  userId: 'user-123',
  sessionId: 'session-abc',
  newMessage: { role: 'user', parts: [{ text: 'Hello' }] },
  stateDelta: {
    'user:preference': 'dark-mode',
    'temp:working_set': []
  }
})) {
  // Process events
}
```

### State Accumulation

State accumulates iteratively as events are appended:

```
Initial: session.state = {}

Event 1: stateDelta = { 'user:name': 'Alice' }
→ session.state = { 'user:name': 'Alice' }

Event 2: stateDelta = { 'user:score': 100 }
→ session.state = { 'user:name': 'Alice', 'user:score': 100 }

Event 3: stateDelta = { 'user:score': 150, 'app:version': '1.0' }
→ session.state = { 'user:name': 'Alice', 'user:score': 150, 'app:version': '1.0' }
```

### Complete Flow Diagram

```
1. Tool/Callback modifies state
   └─ toolContext.state.set('key', value)

2. State delta captured in EventActions
   └─ eventActions.stateDelta['key'] = value

3. Event created with actions
   └─ createEvent({ actions: eventActions })

4. Event appended to session
   └─ sessionService.appendEvent({ session, event })

5. BaseSessionService.appendEvent()
   ├─ Skip if event.partial === true
   ├─ Call updateSessionState()
   │  ├─ Skip temp: prefixed keys
   │  └─ session.state[key] = value
   └─ session.events.push(event)

6. State persisted (InMemorySessionService)
   ├─ app: keys → appState dictionary
   ├─ user: keys → userState dictionary
   ├─ Other keys → session.state
   └─ temp: keys → not persisted

7. State retrieved (getSession)
   ├─ Load session
   ├─ Apply event filters
   └─ Merge app/user state back
```

### Partial Events

Partial events (streaming chunks) are NOT persisted:

```typescript
// In appendEvent()
if (event.partial) {
  return event;  // Skip persistence
}
```

Only final events with `partial === false` (or undefined) update session state and are saved to the event history.

---

## Related Documentation

- [Events](./events.md) - Event structure and actions
- [Agents](./agents.md) - Agent state access
- [Runner](./runner.md) - Runner and session lifecycle
- [Tools](./tools.md) - Tool context and state manipulation
