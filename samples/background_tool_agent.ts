/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BackgroundTool,
  InMemoryRunner,
  LlmAgent,
  LogLevel,
  setLogLevel,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import {fileURLToPath} from 'url';
import {z} from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, '.env'), quiet: true});

const backgroundTool = new BackgroundTool({
  name: 'long_calculation',
  description:
    'Performs a very intensive 5-second calculation in the background. Call that when user asks for a long calculation.',
  parameters: z.object({
    startNumber: z.number(),
  }),
  scriptPath: path.join(__dirname, 'heavy_background_task.ts'),
});

const llmAgent = new LlmAgent({
  name: 'background_agent',
  description: 'Agent that can perform background calculation',
  model: 'gemini-2.5-flash',
  tools: [backgroundTool],
});

const runner = new InMemoryRunner({
  appName: 'background_agent',
  agent: llmAgent,
});

class ContentInputStream<T> {
  private queue: T[] = [];
  private resolves: ((val: IteratorResult<T>) => void)[] = [];
  private isClosed = false;

  push(content: T) {
    if (this.resolves.length > 0) {
      this.resolves.shift()!({value: content, done: false});
    } else {
      this.queue.push(content);
    }
  }

  end() {
    this.isClosed = true;
    while (this.resolves.length > 0) {
      this.resolves.shift()!({value: undefined, done: true});
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.isClosed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.resolves.push(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

async function main() {
  setLogLevel(LogLevel.ERROR);
  const session = await runner.sessionService.createSession({
    appName: 'background_agent',
    userId: 'test_user_id',
  });
  const inputStream = new ContentInputStream<any>();

  inputStream.push(
    createUserContent('Please perform the long calculation with number 10.'),
  );
  const responseStream = runner.runStream({
    userId: 'test_user_id',
    sessionId: session.id,
    inputStream,
  });

  // Automatically answer the tool's confirmation after 3 seconds
  setTimeout(() => {
    console.log(
      "-> inputMessage: 'Yes, proceed.' (Multiplexed while tool is paused)",
    );
    inputStream.push(createUserContent('Yes, proceed.'));
  }, 3000);

  for await (const event of responseStream) {
    if (event.author === 'user') {
      console.log(`-> inputMessage: ${event.content?.parts?.[0]?.text}`);
    } else {
      if (event.content?.parts?.[0]?.functionCall) {
        console.log(
          `-> modelResponse (tool call): ${event.content?.parts?.[0]?.functionCall.name}`,
        );
      } else if (event.content?.parts?.[0]?.functionResponse) {
        console.log(
          `-> workerResponse (background tool finished): ${event.content?.parts?.[0]?.functionResponse.name} ${JSON.stringify(event.content?.parts?.[0]?.functionResponse.response)}`,
        );
      } else if (event.content?.parts?.[0]?.text) {
        console.log(`-> modelResponse: ${event.content?.parts?.[0]?.text}`);
      }
    }
  }
}

main().catch(console.error);
