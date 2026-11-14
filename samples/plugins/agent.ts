/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plugins (`BasePlugin` and `PluginManager`)
 * ../../docs/guides/plugins/index.md
 *
 * A `hello_world` `LlmAgent` with one tool, and a `CountInvocationPlugin` that
 * counts the agent runs, the model requests and the tool calls of the runner.
 * The plugin overrides `beforeAgentCallback`, `beforeModelCallback` and
 * `beforeToolCallback`. Each callback returns `undefined`, so the plugin only
 * observes the run and does not stop it.
 *
 * A plugin belongs to the runner, not to an agent. This sample registers the
 * plugin in two ways: `main()` passes it in the `plugins` option of
 * `InMemoryRunner`, and the exported `app` carries it in `App.plugins`, so that
 * `adk web` and `npm run sample` also apply it. The CLI prefers an exported
 * `app` to a bare `rootAgent`.
 *
 * REQUIRES an API key (the agent calls a live model). Set GEMINI_API_KEY, then:
 *   npx tsx samples/plugins/agent.ts
 *   npm run sample -- samples/plugins/agent.ts
 * Try "hello world".
 */

import type {
  BaseAgent,
  BaseTool,
  Context,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  App,
  BasePlugin,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
} from '@google/adk';
import type {Content} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {inspect} from 'node:util';
import {z} from 'zod';

/** Counts the agent runs, model requests and tool calls of a runner. */
export class CountInvocationPlugin extends BasePlugin {
  private agentCount = 0;
  private llmRequestCount = 0;
  private toolCount = 0;

  constructor() {
    super('count_invocation');
  }

  override async beforeAgentCallback(_params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.agentCount += 1;
    process.stdout.write(`[Plugin] Agent run count: ${this.agentCount}\n`);
    return undefined;
  }

  override async beforeModelCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.llmRequestCount += 1;
    process.stdout.write(
      `[Plugin] LLM request count: ${this.llmRequestCount}\n`,
    );
    return undefined;
  }

  override async beforeToolCallback(_params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    this.toolCount += 1;
    process.stdout.write(`[Plugin] Tool call count: ${this.toolCount}\n`);
    return undefined;
  }
}

const helloWorld = new FunctionTool({
  name: 'hello_world',
  description: 'Prints hello world with the user query.',
  parameters: z.object({
    query: z.string().describe('The query of the user.'),
  }),
  execute: ({query}) => `Hello world: query is [${query}]`,
});

export const rootAgent = new LlmAgent({
  model: 'gemini-flash-latest',
  name: 'hello_world',
  description: 'Prints hello world with the user query.',
  instruction:
    'Use the hello_world tool to print hello world and the user query.',
  tools: [helloWorld],
});

export const app = new App({
  name: 'plugins_sample_app',
  rootAgent,
  plugins: [new CountInvocationPlugin()],
});

async function main() {
  const appName = 'plugins_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName,
    plugins: [new CountInvocationPlugin()],
  });
  const session = await runner.sessionService.createSession({appName, userId});

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'hello world'}]},
  })) {
    process.stdout.write(`** Got event from ${event.author}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? (err.stack ?? err.message) : inspect(err)}\n`,
    );
    process.exit(1);
  });
}
