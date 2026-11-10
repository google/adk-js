# REST session service contract

`RestSessionService` stores ADK sessions through an HTTP service that you run. The agent never connects to the session store. It calls the API described here, and your service owns storage, authentication, tenancy and retention. Any backend that implements this contract works, whatever it stores sessions in.

This document is the contract between `RestSessionService` (the client) and that backend (the server). It is language-neutral, so one backend can serve ADK clients written in any language.

The paths look like the session routes of the ADK dev servers, but this is a separate API. The dev servers return a public view of a session, with ADK-internal metadata removed and credentials redacted. A storage backend has to return what it stored, unchanged. Run it under its own base URL.

## Conventions

- Request and response bodies are JSON (`Content-Type: application/json`).
- `baseUrl` is the client's configured root, such as `https://sessions.example.com/v1`. The paths below are appended to it.
- The client URL-encodes the path segments `appName`, `userId` and `sessionId`.
- The client sends the headers it is configured with on every request. The contract defines no authentication scheme. The server decides which headers it needs, such as `Authorization` or a tenant header.
- Error bodies are `{"error": "<message>"}`. The client includes the message, truncated, in the error it throws, so the message must not contain secrets.
- **Timestamps are epoch seconds, as JSON numbers that may have a fraction.** This is the unit adk-python uses. The JS client converts to and from the epoch milliseconds that ADK-JS uses.

## Data shapes

### Session

```json
{
  "id": "string",
  "appName": "string",
  "userId": "string",
  "state": {"key": "value"},
  "events": [],
  "lastUpdateTime": 1730000000.123
}
```

- `state` is the merged view. Keys with the `app:` prefix are shared by every session of the app, keys with the `user:` prefix are shared by every session of the user, and all other keys belong to this session. The server stores each scope separately and returns them merged, with the prefixes in the key names.
- The client never sends `temp:` keys.
- `events` is ordered by append time, oldest first.
- `lastUpdateTime` is set by the server. The client sends it back unchanged as the precondition of an append. See [Append an event](#append-an-event).

### Event

The serialized ADK `Event`, with field names in camelCase. The server should store it as-is and return it unchanged, so that fields the server does not understand round-trip. This includes `customMetadata` keys that start with `__adk_internal_`, which a storage backend must not remove. The server needs to read only these fields:

| Field                | Use                                                                            |
| :------------------- | :----------------------------------------------------------------------------- |
| `id`                 | Idempotency key. See [Append an event](#append-an-event).                      |
| `timestamp`          | Filtering with `afterTimestamp`.                                               |
| `actions.stateDelta` | Applied to the stored state. `app:` and `user:` keys go to the matching scope. |

## Endpoints

### Create a session

```
POST /apps/{appName}/users/{userId}/sessions
```

Request body:

```json
{"sessionId": "string", "state": {"key": "value"}}
```

The client always sends `sessionId`, generating one when the caller does not choose it, so that a retried create cannot make a second session. `state` is optional.

| Status         | Meaning                                 |
| :------------- | :-------------------------------------- |
| `200` or `201` | Created. The body is the new `Session`. |
| `409`          | A session with this id already exists.  |

On `409` the client throws `AlreadyExistsError`. There is one exception: when an earlier attempt of the same call failed in a way that may have reached the server (a network error, a timeout or a `5xx`), the client reads the session and returns it, because the conflict is likely with its own first attempt.

### Get a session

```
GET /apps/{appName}/users/{userId}/sessions/{sessionId}
```

Query parameters, both optional:

| Parameter         | Meaning                                                                           |
| :---------------- | :-------------------------------------------------------------------------------- |
| `afterTimestamp`  | Return only events whose `timestamp` is at or after this value, in epoch seconds. |
| `numRecentEvents` | Return only the last N events.                                                    |

If both are given, the server applies `afterTimestamp` first, then keeps the last `numRecentEvents`.

| Status | Meaning                                          |
| :----- | :----------------------------------------------- |
| `200`  | The `Session`.                                   |
| `404`  | No such session. The client returns `undefined`. |

### List sessions

```
GET /apps/{appName}/users/{userId}/sessions
GET /apps/{appName}/sessions
```

The second form lists the sessions of every user of the app. The client uses it when `listSessions` is called without `userId`. A server that does not want to offer it can answer with an error status, and the client throws.

Query parameters, all optional:

| Parameter | Meaning                                                          |
| :-------- | :--------------------------------------------------------------- |
| `limit`   | Maximum number of sessions to return.                            |
| `offset`  | Zero-based index of the first session. Ignored if `page` is set. |
| `page`    | 1-based page number. Requires `limit`.                           |
| `order`   | `asc` or `desc`, by `lastUpdateTime`. No ordering if omitted.    |

Response `200`:

```json
{
  "sessions": [],
  "page": 1,
  "limit": 20,
  "totalItems": 1,
  "totalPages": 1
}
```

Sessions in the list can omit `events`. When the pagination fields are missing, the client fills them in as if no pagination was requested.

### Append an event

```
POST /apps/{appName}/users/{userId}/sessions/{sessionId}/events
```

Request body:

```json
{
  "event": {"id": "...", "timestamp": 1730000000.5},
  "lastUpdateTime": 1730000000.123
}
```

`lastUpdateTime` is the value the client last received for this session, sent back unchanged.

The server handles the request in this order:

1. **Replay.** If an event with this `event.id` is already stored, the server replaces the stored event, does **not** apply its `stateDelta` again and does **not** check `lastUpdateTime`. It answers `200` with the session's current `lastUpdateTime`. This makes retries safe. Replacement is also the general rule for an event that ADK rewrites in place.
2. **Staleness (optional).** If the stored `lastUpdateTime` is greater than the one in the request, the session was changed by another writer since the client read it. The server answers `409` and stores nothing.
3. **Append.** The server stores the event, applies `actions.stateDelta` scoped by key prefix, sets a new `lastUpdateTime` that is greater than or equal to the previous one, and answers `200`.

Response `200`:

```json
{"lastUpdateTime": 1730000001.123}
```

| Status | Meaning               | Client behavior                                                          |
| :----- | :-------------------- | :----------------------------------------------------------------------- |
| `200`  | Stored.               | Applies the event to its session object and records `lastUpdateTime`.    |
| `404`  | No such session.      | Throws `SessionNotFoundError`.                                           |
| `409`  | The session is stale. | Throws `StaleSessionError`. The caller re-reads the session and retries. |

Steps 1 to 3 must be atomic for one session. A server that does not need optimistic concurrency can skip step 2 and never return `409`.

Other rules:

- The client sends the writes for one session one at a time, in the order they were made. The server applies state deltas in arrival order.
- The client never sends partial (streaming) events.
- The server must compare `lastUpdateTime` with the exact number it issued. The client never sends a value converted from its own clock in place of one the server sent.

### Delete a session

```
DELETE /apps/{appName}/users/{userId}/sessions/{sessionId}
```

| Status         | Meaning                                             |
| :------------- | :-------------------------------------------------- |
| `204` or `200` | Deleted.                                            |
| `404`          | No such session. The client treats this as success. |

## Client behavior on errors

| Condition                                   | Behavior                                                                                               |
| :------------------------------------------ | :----------------------------------------------------------------------------------------------------- |
| `408`, `429`, `5xx`, network error, timeout | Retried with exponential backoff and jitter, honoring `Retry-After` up to a cap, then the call throws. |
| Other `4xx`                                 | The call throws right away, with no retry.                                                             |
| `404` on get                                | Returns `undefined`.                                                                                   |
| `404` on delete                             | Succeeds.                                                                                              |

Every call is safe to retry: create because the client chooses the id, append because it is idempotent by `event.id`, and get, list and delete because they are idempotent by definition.

## Security

Events and state can contain user content and tool credentials. The backend is trusted storage, in the same way a database is for `DatabaseSessionService`. Serve it over HTTPS, and authenticate the client with the `headers` option.

## Out of scope

- Authentication and authorization schemes.
- Artifacts and memory, which have their own services.
- Server-side pagination limits, rate limits and retention.
