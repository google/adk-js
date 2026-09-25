/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Events (`Event` and `EventActions`)
 * ../../docs/guides/events/event/index.md
 *
 * A deterministic agent that emits a tool-call event, a tool-response event
 * carrying a `stateDelta` and an `artifactDelta`, and a final response. It uses
 * a hand-written `BaseAgent` rather than an `LlmAgent` so it runs without API
 * credentials and always produces the same events.
 *
 * This sample is driven directly, not through the ADK CLI (`npm run sample`).
 * The CLI surfaces the agent's conversational text, but the subject here is the
 * `Event` object itself — its function-call parts, its `EventActions`, and the
 * helper functions that read them. The `main()` driver runs the agent with
 * `InMemoryRunner` and prints each event decomposed into those fields, which is
 * what the CLI does not show. Run it with:
 *   npx tsx samples/events/agent.ts
 */

import {
  BaseAgent,
  createEvent,
  createEventActions,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  hasTrailingCodeExecutionResult,
  InMemoryRunner,
  InvocationContext,
  isFinalResponse,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';

const RECEIPT_FILENAME = 'receipt_ORD-42.json';

class EventsShowcaseAgent extends BaseAgent {
  constructor() {
    super({
      name: 'events_showcase_agent',
      description: 'Demonstrates ADK Event and EventActions lifecycle.',
    });
  }

  protected async *runAsyncImpl(
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
              id: 'call-lookup-1',
              name: 'lookupOrderStatus',
              args: {orderId: 'ORD-42'},
            },
          },
        ],
      },
    });

    // Save the receipt, then report it. `saveArtifact` returns the revision it
    // assigned, and the `artifactDelta` must advertise that revision. The delta
    // stays empty when no artifact service is configured, so the event never
    // claims an artifact that was not written.
    const artifactDelta: Record<string, number> = {};
    if (ctx.artifactService) {
      const revision = await ctx.artifactService.saveArtifact({
        filename: RECEIPT_FILENAME,
        artifact: {
          text: JSON.stringify({
            orderId: 'ORD-42',
            status: 'SHIPPED',
            carrier: 'FastShip',
          }),
        },
      });
      artifactDelta[RECEIPT_FILENAME] = revision;
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
              id: 'call-lookup-1',
              name: 'lookupOrderStatus',
              response: {status: 'SHIPPED', carrier: 'FastShip'},
            },
          },
        ],
      },
      actions: createEventActions({
        stateDelta: {lastOrderId: 'ORD-42', lastOrderStatus: 'SHIPPED'},
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
            text: 'Order ORD-42 has status SHIPPED via FastShip.',
          },
        ],
      },
      actions: createEventActions({
        stateDelta: {completedTurns: 1},
      }),
    });
  }

  protected async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // The events are identical in live mode; delegate rather than duplicate them.
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new EventsShowcaseAgent();

async function main() {
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName: 'events_sample_app',
  });

  const session = await runner.sessionService.createSession({
    appName: 'events_sample_app',
    userId: 'user-1',
    state: {completedTurns: 0},
  });

  console.log('--- Running EventsShowcaseAgent via InMemoryRunner ---');
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'Where is order ORD-42?'}],
    },
  })) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    console.log({
      id: event.id,
      author: event.author,
      isFinal: isFinalResponse(event),
      hasCodeResult: hasTrailingCodeExecutionResult(event),
      functionCalls: calls.map((c) => c.name),
      functionResponses: responses.map((r) => r.name),
      stateDelta: event.actions.stateDelta,
      artifactDelta: event.actions.artifactDelta,
      text: stringifyContent(event),
    });
  }

  const updatedSession = await runner.sessionService.getSession({
    appName: 'events_sample_app',
    userId: session.userId,
    sessionId: session.id,
  });
  console.log('Updated session state:', updatedSession?.state);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
