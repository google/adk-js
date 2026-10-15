/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI and Evaluation Utilities (`createEmptyState`, `convertSessionToEvalFormat`, `runEvals`)
 * ../../docs/guides/cli/index.md
 *
 * A deterministic `BaseAgent` with a child `LlmAgent` whose instruction
 * contains `{department}` and `{locale}` placeholders. The `main()` driver
 * builds initial state via `createEmptyState`, runs a two-turn conversation
 * with `InMemoryRunner` (including a simulated tool call), converts the
 * recorded session into `EvaluationItem` records via
 * `convertSessionToEvalFormat`, and evaluates the agent against the captured
 * dataset with `runEvals`.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and
 * includes a self-contained `main()` driver because `scripts/run_sample.ts`
 * only runs a single agent turn and does not invoke `createEmptyState`,
 * `convertSessionToEvalFormat`, `parseAndGetEvalsToRun`, or `runEvals`.
 *
 * Run (offline, no API key):
 *   npx tsx samples/cli/agent.ts
 *   npm run sample -- samples/cli/agent.ts
 */

import {
  BaseAgent,
  convertSessionToEvalFormat,
  createEmptyState,
  createEvent,
  EvalStatus,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  parseAndGetEvalsToRun,
  runEvals,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';

class OrderSupportAgent extends BaseAgent {
  constructor() {
    super({
      name: 'order_support_agent',
      description:
        'Deterministic support agent that looks up order status and echoes state.',
      subAgents: [
        new LlmAgent({
          name: 'policy_sub_agent',
          model: 'gemini-flash-latest',
          instruction:
            'Answer policy questions for department {department} in locale {locale}.',
        }),
      ],
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const query =
      ctx.userContent?.parts?.map((part) => part.text ?? '').join('') ?? '';

    if (query.toLowerCase().includes('order')) {
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        branch: ctx.branch,
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'lookup_order',
                args: {orderId: 'ORD-100'},
              },
            },
          ],
        },
      });
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        branch: ctx.branch,
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'lookup_order',
                response: {status: 'shipped'},
              },
            },
          ],
        },
      });
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        branch: ctx.branch,
        content: {
          role: 'model',
          parts: [{text: 'Order ORD-100 has shipped.'}],
        },
      });
      return;
    }

    const locale = String(ctx.session.state['locale'] || 'en-US');
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [{text: `[${locale}] Received: ${query}`}],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new OrderSupportAgent();

async function main() {
  const appName = 'cli_sample_app';
  const userId = 'user-1';

  const initialState = createEmptyState(rootAgent, {locale: 'en-GB'});
  process.stdout.write(
    `Initialized state from instruction placeholders: ${JSON.stringify(initialState)}\n`,
  );

  const runner = new InMemoryRunner({agent: rootAgent, appName});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
    state: initialState,
  });

  const queries = ['Check my order status', 'Thank you'];
  for (const text of queries) {
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text}]},
    })) {
      const rendered = stringifyContent(event);
      if (rendered) {
        process.stdout.write(`[${event.author}]: ${rendered}\n`);
      }
    }
  }

  const storedSession = await runner.sessionService.getSession({
    appName,
    userId,
    sessionId: session.id,
  });
  const evalItems = convertSessionToEvalFormat(storedSession);
  process.stdout.write(
    `Converted session turns: ${evalItems.length} (first tool: ${evalItems[0]?.expected_tool_use[0]?.tool_name})\n`,
  );

  const parsedSpecs = parseAndGetEvalsToRun([
    'support.evalset.json:order_flow',
  ]);
  process.stdout.write(`Parsed eval spec: ${JSON.stringify(parsedSpecs)}\n`);

  for await (const result of runEvals({
    evalCasesByEvalSetId: {
      'support.evalset.json': [
        {
          name: 'order_flow',
          data: evalItems,
          initial_session: {
            app_name: appName,
            user_id: userId,
            state: initialState,
          },
        },
      ],
    },
    rootAgent,
  })) {
    process.stdout.write(
      `Eval ${result.eval_id}: ${EvalStatus[result.final_eval_status]}\n`,
    );
    for (const metric of result.overall_eval_metric_results) {
      process.stdout.write(
        `  ${metric.metric_name}: score=${metric.score} status=${EvalStatus[metric.eval_status]}\n`,
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
