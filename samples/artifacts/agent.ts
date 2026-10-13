/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Artifacts (`BaseArtifactService`, `InMemoryArtifactService`, and `SessionArtifactService`)
 * ../../docs/guides/artifacts/index.md
 *
 * A deterministic `BaseAgent` that saves two revisions of a session-scoped
 * report (`quarterly_report.md`) and a cross-session user preference artifact
 * (`user:report_theme.json`) through `ctx.artifactService`, records their
 * assigned revision numbers in `EventActions.artifactDelta`, and reads back
 * both historical and latest revisions.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `InMemoryRunner` driver (`main()`) because the CLI only
 * prints conversational text — running directly lets `main()` inspect the
 * `artifactDelta` on each `Event` and verify that `user:`-prefixed artifacts
 * remain accessible from a second session while session-scoped artifacts stay
 * isolated.
 *
 * Run (offline, no API key):
 *   npx tsx samples/artifacts/agent.ts
 *   npm run sample -- samples/artifacts/agent.ts
 */

import {
  BaseAgent,
  createEvent,
  createEventActions,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryRunner,
  InvocationContext,
  isFinalResponse,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';

const REPORT_FILENAME = 'quarterly_report.md';
const USER_THEME_FILENAME = 'user:report_theme.json';

class ArtifactsShowcaseAgent extends BaseAgent {
  constructor() {
    super({
      name: 'artifacts_showcase_agent',
      description:
        'Demonstrates versioned session and user-scoped artifacts via ctx.artifactService.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-artifact-1',
              name: 'saveAndInspectReportArtifact',
              args: {
                reportFilename: REPORT_FILENAME,
                userThemeFilename: USER_THEME_FILENAME,
              },
            },
          },
        ],
      },
    });

    const artifactDelta: Record<string, number> = {};
    let versions: number[] = [];
    let keys: string[] = [];
    let draftText = '';
    let latestText = '';

    if (ctx.artifactService) {
      const rev0 = await ctx.artifactService.saveArtifact({
        filename: REPORT_FILENAME,
        artifact: {text: '# Q1 Report (Draft)\nRevenue: $1.2M'},
        customMetadata: {stage: 'draft'},
      });
      const rev1 = await ctx.artifactService.saveArtifact({
        filename: REPORT_FILENAME,
        artifact: {text: '# Q1 Report (Final)\nRevenue: $1.4M'},
        customMetadata: {stage: 'final'},
      });
      const userRev = await ctx.artifactService.saveArtifact({
        filename: USER_THEME_FILENAME,
        artifact: {
          text: JSON.stringify({currency: 'USD', format: 'markdown'}),
        },
      });

      artifactDelta[REPORT_FILENAME] = rev1;
      artifactDelta[USER_THEME_FILENAME] = userRev;

      const draftPart = await ctx.artifactService.loadArtifact({
        filename: REPORT_FILENAME,
        version: rev0,
      });
      const latestPart = await ctx.artifactService.loadArtifact({
        filename: REPORT_FILENAME,
      });
      draftText = draftPart?.text ?? '';
      latestText = latestPart?.text ?? '';
      versions = await ctx.artifactService.listVersions(REPORT_FILENAME);
      keys = await ctx.artifactService.listArtifactKeys();
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-artifact-1',
              name: 'saveAndInspectReportArtifact',
              response: {
                appName: ctx.appName,
                reportFilename: REPORT_FILENAME,
                versions,
                keys,
                draftPreview: draftText.split('\n')[0],
                latestPreview: latestText.split('\n')[0],
              },
            },
          },
        ],
      },
      actions: createEventActions({
        stateDelta: {
          latestReportRevision: versions[versions.length - 1] ?? 0,
          artifactKeys: keys,
        },
        artifactDelta,
      }),
    });

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            text: `Saved ${REPORT_FILENAME} revisions [${versions.join(', ')}] (latest: "${latestText.split('\n')[0]}") and user artifact ${USER_THEME_FILENAME}. Visible keys in ${ctx.appName}: ${keys.join(', ')}.`,
          },
        ],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new ArtifactsShowcaseAgent();

async function main() {
  const appName = 'artifacts_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName,
  });

  const session1 = await runner.sessionService.createSession({
    appName,
    userId,
  });

  for await (const event of runner.runAsync({
    userId,
    sessionId: session1.id,
    newMessage: {
      role: 'user',
      parts: [
        {text: 'Save the Q1 report draft, final revision, and user theme.'},
      ],
    },
  })) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    process.stdout.write(
      `${JSON.stringify({
        id: event.id,
        author: event.author,
        isFinal: isFinalResponse(event),
        functionCalls: calls.map((c) => c.name),
        functionResponses: responses.map((r) => r.name),
        artifactDelta: event.actions.artifactDelta,
        text: stringifyContent(event),
      })}\n`,
    );
  }

  const session2 = await runner.sessionService.createSession({
    appName,
    userId,
  });
  const session2Keys = await runner.artifactService?.listArtifactKeys({
    appName,
    userId,
    sessionId: session2.id,
  });
  process.stdout.write(
    `Keys visible in second session (${session2.id}): ${JSON.stringify(session2Keys)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
