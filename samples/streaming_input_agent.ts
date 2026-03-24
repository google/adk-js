/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LogLevel,
  setLogLevel,
} from '@google/adk';
import type {Content} from '@google/genai';
import {createUserContent} from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import {fileURLToPath} from 'url';
import {z} from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, '.env'), quiet: true});

class ContentInputStream<T = Content> {
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

interface ToolResult {
  status: 'success' | 'error';
  report?: string;
  error_message?: string;
}

const getWeatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Retrieves the current weather report for a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: async ({city}: {city: string}): Promise<ToolResult> => {
    if (city.toLowerCase() === 'new york') {
      return {
        status: 'success',
        report:
          'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
      };
    }

    return {
      status: 'error',
      error_message: `Weather information for '${city}' is not available.`,
    };
  },
});

const llmAgent = new LlmAgent({
  name: 'streaming_input_agent',
  description: 'Agent that can answer questions about the weather',
  model: 'gemini-2.5-flash',
  tools: [getWeatherTool],
});

const runner = new InMemoryRunner({
  appName: 'streaming_input_agent',
  agent: llmAgent,
});

async function main() {
  setLogLevel(LogLevel.ERROR);
  const session = await runner.sessionService.createSession({
    appName: 'streaming_input_agent',
    userId: 'test_user_id',
  });
  const inputStream = new ContentInputStream();

  // Push first message
  inputStream.push(createUserContent('Hello'));

  // Start streaming
  const responseStream = runner.runStream({
    userId: 'test_user_id',
    sessionId: session.id,
    inputStream,
  });

  // Push messages after 1 second
  setTimeout(() => {
    inputStream.push(
      createUserContent('I need to know the weather in New York'),
    );
    inputStream.push(
      createUserContent('And what is the current weather in London?'),
    );
  }, 1000);

  // Push message after 2 seconds
  setTimeout(() => {
    inputStream.push(
      createUserContent('And what is the weather in Sunnyvale now?'),
    );
  }, 2000);

  for await (const event of responseStream) {
    if (event.author === 'user') {
      console.log(`-> inputMessage: ${event.content?.parts?.[0]?.text}`);
    } else {
      if (event.content?.parts?.[0]?.functionCall) {
        console.log(
          `-> modelResponse (tool call): ${event.content?.parts?.[0]?.functionCall.name} ${JSON.stringify(event.content?.parts?.[0]?.functionCall.args)}`,
        );
      } else if (event.content?.parts?.[0]?.functionResponse) {
        console.log(
          `-> modelResponse (tool response): ${event.content?.parts?.[0]?.functionResponse.name} ${JSON.stringify(event.content?.parts?.[0]?.functionResponse.response)}`,
        );
      } else if (event.content?.parts?.[0]?.text) {
        console.log(`-> modelResponse: ${event.content?.parts?.[0]?.text}`);
      }
    }
  }
}

/**
 * Expected output:
 *
 * -> inputMessage: Hello
 * -> modelResponse: Hello! I can provide you with weather information. Which city are you interested in?
 * -> inputMessage: I need to know the weather in New York
 * -> inputMessage: And what is the current weather in London?
 * -> modelResponse (tool call): get_weather {"city":"New York"}
 * -> modelResponse (tool response): get_weather {"status":"success","report":"The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit)."}
 * -> inputMessage: And what is the weather in Sunnyvale now?
 * -> modelResponse: The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).
 * -> modelResponse (tool call): get_weather {"city":"London"}
 * -> modelResponse (tool response): get_weather {"status":"error","error_message":"Weather information for 'London' is not available."}
 * -> modelResponse (tool call): get_weather {"city":"Sunnyvale"}
 * -> modelResponse (tool response): get_weather {"status":"error","error_message":"Weather information for 'Sunnyvale' is not available."}
 * -> modelResponse: I'm sorry, but I don't have weather information for London or Sunnyvale at the moment.
 */
main().catch((error) => {
  console.error(error);
});
