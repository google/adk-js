# Artifacts Sample (`BaseArtifactService` and `SessionArtifactService`)

This sample demonstrates how ADK agents store, version, and retrieve session-scoped and `user:`-scoped artifacts through `ctx.artifactService` (`SessionArtifactService`) and `InMemoryArtifactService`, recording each saved revision in `EventActions.artifactDelta`.

## Overview

`ArtifactsShowcaseAgent` is a deterministic `BaseAgent` subclass that writes two revisions (`0` and `1`) of a session-scoped markdown report (`quarterly_report.md`) alongside a cross-session user preference artifact (`user:report_theme.json`). It loads both the initial draft (`version: 0`) and the latest revision (`version: undefined`), lists the revision history with `listVersions`, and verifies that `user:report_theme.json` remains visible from a separate session for the same user.

## Sample Inputs

- `Save the Q1 report draft, final revision, and user theme.`

  _Saves revisions `0` and `1` of `quarterly_report.md` and revision `0` of `user:report_theme.json`, then returns the revision list and visible keys._

- `List the saved report revisions and verify the user theme artifact.`

  _Exercises the same artifact lifecycle in `adk web` and surfaces the `artifactDelta` chips on the tool response event._

## Running the Sample

Run the self-contained `InMemoryRunner` script directly to inspect the `artifactDelta` on each emitted `Event` and confirm cross-session visibility for `user:` keys:

```bash
npx tsx samples/artifacts/agent.ts
```

Or run the exported `rootAgent` interactively through the ADK CLI after building the workspace:

```bash
npm run build
npm run sample -- samples/artifacts/agent.ts
```

`samples/` is not an npm workspace, so it is type-checked separately:

```bash
npm run ts:check:samples
```

## Related Guides

- [Artifacts](../../docs/guides/artifacts/index.md) - `BaseArtifactService`, `InMemoryArtifactService`, `FileArtifactService`, `GcsArtifactService`, and `ctx.artifactService` (`SessionArtifactService`).
