/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RemoteA2AAgent} from '../../src/a2a/a2a_remote_agent.js';
import {toA2a} from '../../src/a2a/agent_to_a2a.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../src/agents/framework_function_calls.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {logger} from '../../src/utils/logger.js';

/** What the agent served over A2A answers with. */
type Reply = 'text' | 'input' | 'credential';

/**
 * An agent that answers with a fixed reply, chosen by the first word of the
 * user's message, so a test drives it without a model.
 */
class ReplyAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const text = context.userContent?.parts?.[0]?.text ?? '';
    const reply = (text.split(' ')[0] || 'text') as Reply;
    const base = {invocationId: context.invocationId, author: this.name};
    if (reply === 'input' || reply === 'credential') {
      const id = `call-${reply}`;
      yield createEvent({
        ...base,
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id,
                name:
                  reply === 'credential'
                    ? REQUEST_CREDENTIAL_FUNCTION_CALL_NAME
                    : 'ask_human',
                args: {question: 'why?'},
              },
            },
          ],
        },
        longRunningToolIds: [id],
      });
      return;
    }
    yield createEvent({
      ...base,
      content: {role: 'model', parts: [{text: `echo: ${text}`}]},
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** One A2A request the server received. */
interface RecordedRequest {
  path: string;
  version?: string;
  method?: string;
}

/** Parses the `data:` lines of an SSE body into JSON values. */
function parseSse(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
}

describe('A2A v1.0 interop through toA2a', () => {
  let server: Server;
  let baseUrl: string;
  let requests: RecordedRequest[];

  beforeEach(async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    requests = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      requests.push({
        path: req.path,
        version: req.header('A2A-Version'),
        method: (req.body as {method?: string} | undefined)?.method,
      });
      next();
    });
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const {port} = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    await toA2a(new ReplyAgent({name: 'reply_agent'}), {
      app,
      host: '127.0.0.1',
      port,
      allowUnauthenticated: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postJsonRpc(
    method: string,
    params: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    });
  }

  function v1Message(text: string, extra: Record<string, unknown> = {}) {
    return {
      messageId: crypto.randomUUID(),
      role: 'ROLE_USER',
      parts: [{text}],
      ...extra,
    };
  }

  describe('agent card', () => {
    it('serves a v1.0 card that declares v1.0 and v0.3 interfaces', async () => {
      const res = await fetch(`${baseUrl}/.well-known/agent-card.json`, {
        headers: {'A2A-Version': '1.0'},
      });
      const card = (await res.json()) as Record<string, unknown>;

      expect(card['url']).toBeUndefined();
      expect(card['protocolVersion']).toBeUndefined();
      expect(card['supportedInterfaces']).toEqual([
        {
          url: `${baseUrl}/jsonrpc`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
          tenant: '',
        },
        {
          url: `${baseUrl}/rest`,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
          tenant: '',
        },
        {
          url: `${baseUrl}/jsonrpc`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '0.3',
          tenant: '',
        },
        {
          url: `${baseUrl}/rest`,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '0.3',
          tenant: '',
        },
      ]);
    });

    it('serves a v0.3 card with the v1.0 interfaces embedded to a request without A2A-Version', async () => {
      const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
      const card = (await res.json()) as Record<string, unknown>;

      expect(card['protocolVersion']).toBe('0.3');
      expect(card['url']).toBe(`${baseUrl}/jsonrpc`);
      expect(card['preferredTransport']).toBe('JSONRPC');
      expect(card['supportedInterfaces']).toContainEqual(
        expect.objectContaining({protocolVersion: '1.0'}),
      );
    });
  });

  describe('server', () => {
    it('answers a v1.0 SendMessage with a v1.0 task', async () => {
      const res = await postJsonRpc(
        'SendMessage',
        {message: v1Message('hello')},
        {'A2A-Version': '1.0'},
      );
      const body = (await res.json()) as {
        result: {task: Record<string, unknown>};
      };
      const task = body.result.task;

      expect(task['kind']).toBeUndefined();
      expect(task['status']).toMatchObject({state: 'TASK_STATE_COMPLETED'});
      expect(task['artifacts']).toEqual([
        expect.objectContaining({
          parts: [{text: 'echo: hello'}],
        }),
      ]);
      expect(task['contextId']).toEqual(expect.any(String));
    });

    it('streams a v1.0 SendStreamingMessage that opens with the task and ends on completion', async () => {
      const res = await postJsonRpc(
        'SendStreamingMessage',
        {message: v1Message('hello')},
        {'A2A-Version': '1.0'},
      );
      const events = parseSse(await res.text()) as Array<{
        result: Record<string, Record<string, unknown>>;
      }>;
      const payloads = events.map((event) => Object.keys(event.result)[0]);

      expect(payloads[0]).toBe('task');
      expect(payloads).toContain('artifactUpdate');
      expect(payloads.at(-1)).toBe('statusUpdate');
      expect(events.at(-1)!.result['statusUpdate']['status']).toMatchObject({
        state: 'TASK_STATE_COMPLETED',
      });
    });

    it('ends a v1.0 stream that pauses for a credential', async () => {
      const res = await postJsonRpc(
        'SendStreamingMessage',
        {message: v1Message('credential')},
        {'A2A-Version': '1.0'},
      );
      const events = parseSse(await res.text()) as Array<{
        result: Record<string, Record<string, unknown>>;
      }>;

      expect(events.at(-1)!.result['statusUpdate']['status']).toMatchObject({
        state: 'TASK_STATE_AUTH_REQUIRED',
      });
    });

    it('resumes a paused task when the client answers the request', async () => {
      const first = (await (
        await postJsonRpc(
          'SendMessage',
          {message: v1Message('input')},
          {'A2A-Version': '1.0'},
        )
      ).json()) as {result: {task: {id: string; contextId: string}}};
      const {id: taskId, contextId} = first.result.task;

      const res = await postJsonRpc(
        'SendStreamingMessage',
        {
          message: {
            messageId: crypto.randomUUID(),
            role: 'ROLE_USER',
            taskId,
            contextId,
            parts: [
              {
                data: {id: 'call-input', name: 'ask_human', response: {}},
                metadata: {adk_type: 'function_response'},
              },
            ],
          },
        },
        {'A2A-Version': '1.0'},
      );
      const events = parseSse(await res.text()) as Array<{
        result: Record<string, Record<string, unknown>>;
      }>;

      // A v1.0 stream must open with the task, even when it continues one.
      expect(events[0].result['task']).toMatchObject({
        id: taskId,
        status: {state: 'TASK_STATE_WORKING'},
      });
      expect(events.at(-1)!.result['statusUpdate']['status']).toMatchObject({
        state: 'TASK_STATE_COMPLETED',
      });
    });

    it('answers a v0.3 message/send through the compatibility layer', async () => {
      const res = await postJsonRpc('message/send', {
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [{kind: 'text', text: 'hello'}],
        },
      });
      const body = (await res.json()) as {result: Record<string, unknown>};

      expect(body.result['kind']).toBe('task');
      expect(body.result['status']).toMatchObject({state: 'completed'});
      expect(body.result['artifacts']).toEqual([
        expect.objectContaining({
          parts: [expect.objectContaining({kind: 'text', text: 'echo: hello'})],
        }),
      ]);
    });

    it('rejects a v1.0 method name sent without A2A-Version, which means v0.3', async () => {
      const res = await postJsonRpc('SendMessage', {
        message: v1Message('hello'),
      });
      const body = (await res.json()) as {error?: {code: number}};

      expect(body.error).toBeDefined();
    });
  });

  describe('RemoteA2AAgent', () => {
    async function runRemote(
      agent: RemoteA2AAgent,
      text: string,
    ): Promise<Event[]> {
      const sessionService = new InMemorySessionService();
      const runner = new Runner({appName: 'caller', agent, sessionService});
      const session = await sessionService.createSession({
        appName: 'caller',
        userId: 'user',
      });
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        events.push(event);
      }
      return events;
    }

    function textOf(events: Event[]): string[] {
      return events.flatMap(
        (event) =>
          event.content?.parts
            ?.map((part) => part.text)
            .filter((t): t is string => !!t) ?? [],
      );
    }

    it('calls a v1.0 agent over v1.0 when the card declares it', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote',
        agentCard: baseUrl,
      });

      const events = await runRemote(agent, 'hello');

      expect(events.map((event) => event.errorMessage).filter(Boolean)).toEqual(
        [],
      );
      expect(textOf(events)).toContain('echo: hello');
      const rpc = requests.filter((r) => r.path === '/jsonrpc');
      expect(rpc.length).toBeGreaterThan(0);
      for (const request of rpc) {
        expect(request.version).toBe('1.0');
        expect(request.method).toBe('SendStreamingMessage');
      }
    });

    it('falls back to v0.3 for a card that declares only v0.3', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote',
        agentCard: {
          name: 'reply_agent',
          description: 'A v0.3 agent',
          protocolVersion: '0.3.0',
          version: '1.0.0',
          url: `${baseUrl}/jsonrpc`,
          preferredTransport: 'JSONRPC',
          capabilities: {streaming: true},
          defaultInputModes: ['text'],
          defaultOutputModes: ['text'],
          skills: [],
        } as never,
      });

      const events = await runRemote(agent, 'hello');

      expect(events.map((event) => event.errorMessage).filter(Boolean)).toEqual(
        [],
      );
      expect(textOf(events)).toContain('echo: hello');
      const rpc = requests.filter((r) => r.path === '/jsonrpc');
      expect(rpc.length).toBeGreaterThan(0);
      for (const request of rpc) {
        expect(request.version ?? '0.3').toBe('0.3');
        expect(request.method).toBe('message/stream');
      }
    });

    it('surfaces a v1.0 input-required pause as a long-running call', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote',
        agentCard: baseUrl,
      });

      const events = await runRemote(agent, 'input');

      const pause = events.find((event) => event.longRunningToolIds?.length);
      expect(pause?.longRunningToolIds).toEqual(['call-input']);
      expect(pause?.content?.parts?.[0]?.functionCall).toMatchObject({
        id: 'call-input',
        name: 'ask_human',
      });
      expect(pause?.customMetadata?.['a2a:task_id']).toEqual(
        expect.any(String),
      );
    });

    it('resumes a v1.0 task without relaying the output of the earlier turn again', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote',
        agentCard: baseUrl,
      });
      const sessionService = new InMemorySessionService();
      const runner = new Runner({appName: 'caller', agent, sessionService});
      const session = await sessionService.createSession({
        appName: 'caller',
        userId: 'user',
      });
      const run = async (parts: Event['content']) => {
        const events: Event[] = [];
        for await (const event of runner.runAsync({
          userId: 'user',
          sessionId: session.id,
          newMessage: parts!,
        })) {
          events.push(event);
        }
        return events;
      };

      const first = await run({role: 'user', parts: [{text: 'input'}]});
      const taskId = first.find((e) => e.longRunningToolIds?.length)
        ?.customMetadata?.['a2a:task_id'];
      const second = await run({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-input',
              name: 'ask_human',
              response: {answer: 'because'},
            },
          },
        ],
      });

      expect(second.map((e) => e.errorMessage).filter(Boolean)).toEqual([]);
      expect(
        second.some((e) => e.content?.parts?.some((p) => p.functionCall)),
      ).toBe(false);
      expect(textOf(second)).toContain('echo: ');
      expect(second.at(-1)?.customMetadata?.['a2a:task_id']).toBe(taskId);
    });
  });
});
