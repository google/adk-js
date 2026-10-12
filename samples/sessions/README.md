# Sessions Sample (`Session`, `State`, and `InMemorySessionService`)

This sample demonstrates how session state is scoped. One agent writes a session key, a `user:` key, an `app:` key and a `temp:` key through `EventActions.stateDelta`, and `InMemorySessionService` stores each scope separately.

## Overview

`SessionStateAgent` is a deterministic `BaseAgent` subclass that calls no model. On each turn it reads `ctx.session.state` and emits one event whose `stateDelta` sets:

- `turnCount`, a session key, so it counts turns in the current session only.
- `user:visits`, a user key, so it counts turns across every session of the user.
- `app:totalTurns`, an app key, so it counts turns across every user of the app.
- `temp:lastMessage`, a temporary key, so the session service never stores it.

The `main()` driver creates a session with the padded id `'  first-session  '`, which the service stores as `'first-session'`. It runs two turns in that session and one in a second session for the same user, and prints the state that `getSession` returns after each turn. In the second session, `user:visits` and `app:totalTurns` continue from the first session, `turnCount` starts again at `1`, and `temp:lastMessage` is absent everywhere.

## Sample Inputs

- `Hello`

  _Turn 1 of the session: every counter reads `1`._

- `Hello again`

  _Turn 2 of the same session: every counter reads `2`._

- Any message in a new session for the same user

  _`turnCount` reads `1`, while `user:visits` and `app:totalTurns` keep counting._

## Running the Sample

The sample needs nothing beyond the workspace build: no API key and no database.

Run the self-contained `InMemoryRunner` script directly to see the trimmed session id and the stored state after each turn:

```bash
npx tsx samples/sessions/agent.ts
```

Or run the exported `rootAgent` interactively through the ADK CLI after building the workspace:

```bash
npm run build
npm run sample -- samples/sessions/agent.ts
```

To use the browser UI instead, serve the file with `adk web`. From the repository, the built CLI is `dev/dist/esm/cli_entrypoint.js`:

```bash
node dev/dist/esm/cli_entrypoint.js web samples/sessions/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Sessions](../../docs/guides/sessions/index.md) - `Session`, `State`, `BaseSessionService`, and the in-memory, database and Vertex AI session services.
