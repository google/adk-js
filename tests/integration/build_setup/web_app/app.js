/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal chat app driven by ADK, used by web_app_test.ts.
 *
 * It imports the shipped browser bundle directly, with no build step of its
 * own, so the test exercises the artifact a real application would load rather
 * than something the test assembled.
 */
import {
  BaseLlm,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '../../../../core/dist/web/index_web.js';

const APP_NAME = 'web_app';
const USER_ID = 'web_user';
const ADD_PROMPT = 'add 2 and 3';

/**
 * Stands in for a real model, as the Node integration tests do.
 *
 * Asked to add, it calls the `add` tool and then reports what the tool
 * returned, error included. Anything else gets a fixed greeting.
 */
class MockLlm extends BaseLlm {
  static supportedModels = ['mock-web-model'];

  async *generateContentAsync(llmRequest) {
    const lastPart = llmRequest.contents.at(-1)?.parts?.at(-1);
    const toolResult = lastPart?.functionResponse?.response;

    let part = {text: 'Hello from the agent'};
    if (lastPart?.text === ADD_PROMPT) {
      part = {functionCall: {name: 'add', args: {a: 2, b: 3}}};
    } else if (toolResult) {
      part = {
        text: toolResult.error
          ? `Tool failed: ${toolResult.error}`
          : `The sum is ${toolResult.sum}`,
      };
    }

    yield {content: {role: 'model', parts: [part]}, turnComplete: true};
  }

  async connect() {
    throw new Error('live connection is not used by this app');
  }
}

const messages = document.getElementById('messages');

function addMessage(author, text) {
  const li = document.createElement('li');
  li.dataset.author = author;
  li.textContent = text;
  messages.appendChild(li);
}

const add = new FunctionTool({
  name: 'add',
  description: 'Adds two numbers.',
  parameters: {
    type: 'OBJECT',
    properties: {a: {type: 'NUMBER'}, b: {type: 'NUMBER'}},
    required: ['a', 'b'],
  },
  execute: ({a, b}) => ({sum: a + b}),
});

const agent = new LlmAgent({
  name: 'web_agent',
  model: new MockLlm({model: 'mock-web-model'}),
  instruction: 'You are a helpful assistant.',
  tools: [add],
});

const sessionService = new InMemorySessionService();
const runner = new Runner({appName: APP_NAME, agent, sessionService});
const session = await sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});

async function send() {
  const input = document.getElementById('prompt');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addMessage('user', text);

  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    const reply = (event.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (reply && event.author === 'web_agent') {
      addMessage('agent', reply);
    }
  }
}

document.getElementById('send').addEventListener('click', () => {
  void send();
});

document.getElementById('status').textContent = 'ready';
