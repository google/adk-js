# Artifacts (`BaseArtifactService`, `InMemoryArtifactService`, `FileArtifactService`, and `GcsArtifactService`)

Artifact services in the Agent Development Kit (ADK) persist versioned binary and text payloads (`Part` objects from `@google/genai`) scoped to an application, user, and session, or shared across all of a user's sessions through the `user:` filename prefix.

All storage backends implement `BaseArtifactService` and can be resolved from a connection URI via `getArtifactServiceFromUri`:

- `InMemoryArtifactService` (`memory://`) - Stores artifacts in process memory for unit tests, local development, and ephemeral runs.
- `FileArtifactService` (`file://<path>`) - Persists versioned artifact payloads and `metadata.json` files on the local filesystem under a root directory.
- `GcsArtifactService` (`gs://<bucket>`) - Persists versioned artifacts as objects in Google Cloud Storage, loading `@google-cloud/storage` as an optional peer on first use.
- `ScopedArtifactService` (`SessionArtifactService`) - Wraps a `BaseArtifactService` with fixed `appName`, `userId`, and `sessionId` coordinates so agents and tools call `ctx.artifactService` with only a `filename`.

## Introduction

Conversation events carry small structured turns, whereas generated reports, images, audio clips, and reference files benefit from versioned storage outside the prompt history. `BaseArtifactService` assigns an incrementing zero-based integer revision (`0`, `1`, `2`, ...) every time a `filename` is saved and records the resulting `{[filename]: version}` mapping in `EventActions.artifactDelta`.

Within an agent or tool callback, ADK exposes a session-bound `SessionArtifactService` on `ctx.artifactService` (implemented by `ScopedArtifactService`). Application code outside an invocation interacts directly with `BaseArtifactService` implementations (`InMemoryArtifactService`, `FileArtifactService`, or `GcsArtifactService`), passing `{appName, userId, sessionId}` on each request.

## Get started

Create an `InMemoryArtifactService`, save two revisions of a session-scoped document alongside a `user:`-scoped preference artifact, and read back specific revisions.

```ts
import {InMemoryArtifactService} from '@google/adk';

const artifactService = new InMemoryArtifactService();
const sessionScope = {
  appName: 'reporting_app',
  userId: 'user-1',
  sessionId: 'session-1',
};

const rev0 = await artifactService.saveArtifact({
  ...sessionScope,
  filename: 'quarterly_report.md',
  artifact: {text: '# Q1 Report (Draft)\nRevenue: $1.2M'},
  customMetadata: {stage: 'draft'},
});

const rev1 = await artifactService.saveArtifact({
  ...sessionScope,
  filename: 'quarterly_report.md',
  artifact: {text: '# Q1 Report (Final)\nRevenue: $1.4M'},
  customMetadata: {stage: 'final'},
});

await artifactService.saveArtifact({
  ...sessionScope,
  filename: 'user:report_theme.json',
  artifact: {text: JSON.stringify({currency: 'USD', format: 'markdown'})},
});

const draft = await artifactService.loadArtifact({
  ...sessionScope,
  filename: 'quarterly_report.md',
  version: rev0,
});
const latest = await artifactService.loadArtifact({
  ...sessionScope,
  filename: 'quarterly_report.md',
});
const versions = await artifactService.listVersions({
  ...sessionScope,
  filename: 'quarterly_report.md',
});
const keys = await artifactService.listArtifactKeys(sessionScope);

console.log('Saved revisions:', [rev0, rev1]); // [0, 1]
console.log('Draft text:', draft?.text);
console.log('Latest text:', latest?.text);
console.log('Available versions:', versions); // [0, 1]
console.log('Session + user keys:', keys); // ['quarterly_report.md', 'user:report_theme.json']
```

## How it works

1. **Zero-based revision numbering (`saveArtifact`)**: The first save for a given `{appName, userId, sessionId, filename}` tuple stores revision `0` and returns `0`. Each subsequent save appends the next integer (`1`, `2`, ...) without overwriting prior revisions. Every backend validates that `artifact` contains at least one of `inlineData`, `text`, or `fileData`, rejecting with `Error('Artifact must have either inlineData or text content.')` when all three are absent.
2. **Session vs. user namespace (`user:` prefix)**: Filenames that start with `'user:'` (for example, `'user:report_theme.json'`) are stored under the user's namespace (`{appName}/{userId}/user/...`) instead of a single session. `listArtifactKeys` merges both the active session's keys and the user's `'user:'`-prefixed keys in lexicographical order, making `'user:'` artifacts readable from every session belonging to that `userId`.
3. **Loading latest or pinned revisions (`loadArtifact`)**: Leaving `version` as `undefined` loads the highest revision number for `filename`. Passing an explicit `version: number` retrieves that historical snapshot. If the artifact or version does not exist, `loadArtifact` resolves to `undefined` (whereas `adk-python` returns `None`).
4. **Version metadata inspection (`listArtifactVersions`, `getArtifactVersion`)**: Beyond `adk-python` v0.1.0, `BaseArtifactService` in TypeScript includes `listArtifactVersions` and `getArtifactVersion`, which return `ArtifactVersion` objects carrying `version`, `mimeType`, `customMetadata`, and `canonicalUri`.
5. **Session-scoped delegation (`ctx.artifactService`)**: When `Runner` constructs an `InvocationContext`, it wraps the configured `BaseArtifactService` in a `ScopedArtifactService` implementing `SessionArtifactService` (identifiable via `isSessionArtifactService`). Inside `BaseAgent.runAsyncImpl` or tool callbacks, callers pass `{filename, artifact, customMetadata?}` to `ctx.artifactService.saveArtifact(...)` without repeating `appName`, `userId`, or `sessionId`, and then record `{[filename]: revision}` on `EventActions.artifactDelta`.

## Configuration options

### `SaveArtifactRequest` (`BaseArtifactService.saveArtifact`)

| Property         | Type                      | Default     | Description                                                                    |
| :--------------- | :------------------------ | :---------- | :----------------------------------------------------------------------------- |
| `appName`        | `string`                  | Required    | Application identifier partitioning storage.                                   |
| `userId`         | `string`                  | Required    | User identifier owning the session or `user:` namespace.                       |
| `sessionId`      | `string`                  | Required    | Session identifier for session-scoped filenames.                               |
| `filename`       | `string`                  | Required    | Artifact key; prefix with `'user:'` to share across all sessions for `userId`. |
| `artifact`       | `Part`                    | Required    | `@google/genai` `Part` payload containing `text`, `inlineData`, or `fileData`. |
| `customMetadata` | `Record<string, unknown>` | `undefined` | Optional key-value metadata persisted alongside the artifact version.          |

### `LoadArtifactRequest` (`BaseArtifactService.loadArtifact` and `getArtifactVersion`)

| Property    | Type     | Default     | Description                                                               |
| :---------- | :------- | :---------- | :------------------------------------------------------------------------ |
| `appName`   | `string` | Required    | Application identifier.                                                   |
| `userId`    | `string` | Required    | User identifier.                                                          |
| `sessionId` | `string` | Required    | Session identifier.                                                       |
| `filename`  | `string` | Required    | Artifact filename to retrieve.                                            |
| `version`   | `number` | `undefined` | Zero-based revision to load; when `undefined`, loads the latest revision. |

### `SessionArtifactService` (`ctx.artifactService`)

| Method                 | Request / Parameter Type                                               | Return Type                             | Description                                                                          |
| :--------------------- | :--------------------------------------------------------------------- | :-------------------------------------- | :----------------------------------------------------------------------------------- |
| `saveArtifact`         | `SessionSaveArtifactRequest` (`{filename, artifact, customMetadata?}`) | `Promise<number>`                       | Saves a new revision scoped to the active session and returns its revision number.   |
| `loadArtifact`         | `SessionLoadArtifactRequest` (`{filename, version?}`)                  | `Promise<Part \| undefined>`            | Loads the latest or specified revision from the active session or `user:` namespace. |
| `listArtifactKeys`     | `()` (no arguments)                                                    | `Promise<string[]>`                     | Lists sorted session-scoped and `user:`-scoped filenames visible to the session.     |
| `deleteArtifact`       | `filename: string`                                                     | `Promise<void>`                         | Deletes all revisions of `filename` in the active scope.                             |
| `listVersions`         | `filename: string`                                                     | `Promise<number[]>`                     | Lists ascending integer revisions (`[0, 1, ...]`) for `filename`.                    |
| `listArtifactVersions` | `filename: string`                                                     | `Promise<ArtifactVersion[]>`            | Lists `ArtifactVersion` metadata objects for every revision of `filename`.           |
| `getArtifactVersion`   | `SessionLoadArtifactRequest` (`{filename, version?}`)                  | `Promise<ArtifactVersion \| undefined>` | Returns the `ArtifactVersion` metadata for the specified or latest revision.         |

### `ArtifactVersion` properties

| Property         | Type                      | Default     | Description                                                                                   |
| :--------------- | :------------------------ | :---------- | :-------------------------------------------------------------------------------------------- |
| `version`        | `number`                  | Required    | Zero-based integer revision assigned by `saveArtifact`.                                       |
| `canonicalUri`   | `string`                  | `undefined` | Storage URI (`file://...` on `FileArtifactService`, public blob URL on `GcsArtifactService`). |
| `customMetadata` | `Record<string, unknown>` | `undefined` | Caller-supplied metadata stored with the revision.                                            |
| `mimeType`       | `string`                  | `undefined` | Content MIME type recorded for binary or `fileData` payloads.                                 |

## Advanced applications

### Selecting a backend from a URI with `getArtifactServiceFromUri`

Use `getArtifactServiceFromUri` to switch between in-memory, local disk, and Google Cloud Storage backends via configuration strings without changing application code.

```ts
import {getArtifactServiceFromUri} from '@google/adk';

const memoryStore = getArtifactServiceFromUri('memory://');
const fileStore = getArtifactServiceFromUri('file:///tmp/adk-artifacts');
const gcsStore = getArtifactServiceFromUri('gs://my-adk-artifacts-bucket');
```

### Emitting `artifactDelta` from a custom `BaseAgent`

When an agent writes an artifact through `ctx.artifactService`, capture the returned revision number and attach it to `EventActions.artifactDelta` only when `ctx.artifactService` is configured.

```ts
import {
  BaseAgent,
  createEvent,
  createEventActions,
  Event,
  InvocationContext,
} from '@google/adk';

export class ReportWriterAgent extends BaseAgent {
  constructor() {
    super({name: 'report_writer_agent'});
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const artifactDelta: Record<string, number> = {};
    if (ctx.artifactService) {
      const rev = await ctx.artifactService.saveArtifact({
        filename: 'summary.txt',
        artifact: {text: `Summary for ${ctx.appName}`},
      });
      artifactDelta['summary.txt'] = rev;
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Saved summary.txt.'}]},
      actions: createEventActions({artifactDelta}),
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}
```

## Limitations

- **`GcsArtifactService` optional peer dependency**: `GcsArtifactService` dynamically imports `@google-cloud/storage` on first bucket access via `loadOptionalPeer`. Install `@google-cloud/storage` in projects that use `GcsArtifactService` or `gs://` URIs.
- **`FileArtifactService` lexical path validation**: `FileArtifactService` validates `userId` and `sessionId` against `SAFE_SEGMENT_RE` (`^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]{0,255}$`) and rejects filenames that resolve outside the target scope directory (`assertInsideRoot`). This check is a lexical path guard (`path.resolve` / `path.relative`), not an OS-level sandbox against symlinks or concurrent filesystem modification.
- **Deletion removes all revisions**: `deleteArtifact` deletes the entire revision history of `filename` in the target scope; individual historical versions cannot be deleted selectively.

## Related samples

- [`samples/artifacts/`](../../../samples/artifacts/README.md) - Runnable sample exercising `InMemoryArtifactService`, `ScopedArtifactService` (`ctx.artifactService`), revision history, `user:` cross-session scoping, and `EventActions.artifactDelta`.
