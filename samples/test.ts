import {
  BasePlugin,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  createEvent,
  createEventActions,
} from '@google/adk';
import type {Content} from '@google/genai';
import {createUserContent} from '@google/genai';

// 1) Define the sleep tool
const sleepTool = new FunctionTool({
  name: 'sleep',
  description: 'Sleeps for a provided number of seconds',
  parameters: {
    type: 'object',
    properties: {
      seconds: {type: 'number', description: 'Number of seconds to sleep'},
    },
    required: ['seconds'],
  },
  execute: async ({seconds}: {seconds: number}) => {
    console.log(`\n[Tool] Sleeping for ${seconds} seconds...`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    console.log(`[Tool] Finished sleeping for ${seconds} seconds.`);
    return {status: 'done', slept: seconds};
  },
});

// 2 & 3) Create agent with steering logic in beforeModelCallback
const agent = new LlmAgent({
  name: 'steering-agent',
  model: 'gemini-3-flash-preview',
  instruction:
    'You are a helpful assistant that can sleep. If you receive a steering hint to stop sleeping or change your plan, follow it immediately.',
  tools: [sleepTool],
  // The callback receives the outgoing request and the current context (which includes state)
  beforeModelCallback: async ({request, context}) => {
    const steeringQueue =
      (context.state.get('steeringQueue') as string[]) || [];
    console.log(
      `\n[Debug] beforeModelCallback - current steeringQueue: ${JSON.stringify(steeringQueue)}`,
    );

    if (steeringQueue.length > 0) {
      console.log(`[Callback] Injecting steering messages: ${steeringQueue}`);

      // Append steering messages as user content to the request
      for (const message of steeringQueue) {
        request.contents.push(createUserContent(`(HINT: ${message})`));
      }

      // 3) Clear the queue after appending
      context.state.set('steeringQueue', []);
    }

    return undefined;
  },
});

class MyPlugin extends BasePlugin {
  invocationContext?: InvocationContext;

  async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    this.invocationContext = invocationContext;
    return;
  }
}

async function main() {
  const appName = 'steering-demo';
  const userId = 'user-123';
  const sessionId = 'session-456';

  const plugin = new MyPlugin('my-plugin');
  const runner = new InMemoryRunner({
    agent,
    appName,
    plugins: [plugin],
  });

  const steeringQueue: string[] = [];

  // Initialize session state
  const session = await runner.sessionService.createSession({
    appName,
    userId,
    sessionId,
    state: {steeringQueue},
  });

  console.log('--- Starting Agent ---');
  const prompt =
    "sleep for 5 seconds, then sleep for 3 seconds and say 'hello'";
  console.log(`Prompt: "${prompt}"`);

  const stream = runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: createUserContent(prompt),
  });

  // 4) Simulate sending a steering message mid-generation using session state updates
  // We'll wait 2 seconds (while the 5s sleep is happening) to queue the message
  setTimeout(async () => {
    console.log(
      "\n[External] Queuing steering message: 'actually don't sleep anymore and say goodbye'",
    );

    const currentQueue = (session?.state['steeringQueue'] as string[]) || [];

    // In ADK, we can append an event with a stateDelta to update state
    const updateEvent = createEvent({
      invocationId: plugin.invocationContext?.invocationId || 'manual-steering',
      author: 'system',
      actions: createEventActions({
        stateDelta: {
          steeringQueue: [
            ...currentQueue,
            "actually don't sleep anymore and say 'goodbye'",
          ],
        },
      }),
    });

    await runner.sessionService.appendEvent({
      session: session!,
      event: updateEvent,
    });
    console.log('[External] Event appended to session state.');
  }, 2000);

  try {
    for await (const event of stream) {
      if (event.content) {
        for (const part of event.content.parts) {
          if (part.text) {
            process.stdout.write(part.text);
          }
          if (part.functionCall) {
            console.log(
              `\n[Model] Requested tool call: ${part.functionCall.name}(${JSON.stringify(part.functionCall.args)})`,
            );
          }
        }
      }
    }
  } catch (error) {
    console.error('\nError during execution:', error);
  }

  console.log('\n\n--- Execution Finished ---');
}

main();
