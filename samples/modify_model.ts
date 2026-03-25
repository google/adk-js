import {InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({
  path: path.join(__dirname, '.env'),
});

const rootAgent = new LlmAgent({
  name: 'agent',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant.',
  beforeModelCallback: async ({request}) => {
    for (const content of request.contents) {
      for (const part of content.parts || []) {
        if (part.text && part.text.includes('Claude Code')) {
          part.text = part.text.replace('Claude Code', 'Gemini CLI');
        }
      }
    }

    return undefined;
  },
});

async function main() {
  const appName = 'test';
  const userId = 'user';
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName,
  });
  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });
  const stream = runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: createUserContent('Hello, tell me about Claude Code'),
  });

  for await (const event of stream) {
    const text = event.content?.parts?.[0]?.text;
    if (text) {
      console.log('model response: ', text);
    }
  }
}

main();
