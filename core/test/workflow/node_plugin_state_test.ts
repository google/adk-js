/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {Runner} from '../../src/runner/runner.js';
import {AppendEventRequest} from '../../src/sessions/base_session_service.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';

class SeedState extends BasePlugin {
  calls = 0;
  constructor(private readonly target: BaseNode) {
    super('seed-state');
  }

  override async beforeNodeCallback({
    node,
    nodeContext,
  }: {
    node: BaseNode;
    nodeContext: NodeContext;
  }) {
    if (node === this.target) {
      this.calls++;
      nodeContext.state.set('seed', 'from-plugin');
    }
  }
}

describe('before-node callback state', () => {
  it.each(['leaf', 'retry', 'workflow'])(
    'persists callback writes for a %s node',
    async (kind) => {
      let attempts = 0;
      const leaf = node(
        (ctx: NodeContext) => {
          attempts++;
          if (kind === 'retry' && attempts === 1) {
            ctx.state.set('failedAttempt', true);
            throw new Error('transient');
          }
          return ctx.state.get('seed');
        },
        {
          name: 'leaf',
          isolationScope: 'leaf-scope',
          retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0},
        },
      );
      const workflow = new Workflow({
        name: 'wf',
        isolationScope: 'workflow-scope',
        edges: [['START', leaf]],
      });
      const target = kind === 'workflow' ? workflow : leaf;
      const plugin = new SeedState(target);
      const runner = new InMemoryRunner({
        appName: 'app',
        agent: workflow,
        plugins: [plugin],
      });
      const session = await runner.sessionService.createSession({
        appName: 'app',
        userId: 'u',
        state: kind === 'leaf' ? {seed: 'old'} : {},
      });
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      })) {
        events.push(event);
      }
      expect(
        events.filter((event) => event.output !== undefined).at(-1)?.output,
      ).toBe('from-plugin');
      const stored = await runner.sessionService.getSession({
        appName: 'app',
        userId: 'u',
        sessionId: session.id,
      });
      expect(stored?.state).toEqual({seed: 'from-plugin'});
      const stateEvents = events.filter(
        (event) => event.actions.stateDelta.seed !== undefined,
      );
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        author: target.name,
        isolationScope: kind === 'workflow' ? 'workflow-scope' : 'leaf-scope',
        actions: {stateDelta: {seed: 'from-plugin'}},
        nodeInfo: {path: kind === 'workflow' ? 'wf' : 'wf.leaf'},
      });
      expect(stateEvents[0].invocationId).not.toBe('');
      expect(stateEvents[0].output).toBeUndefined();
      expect(stateEvents[0].content).toBeUndefined();
      expect(plugin.calls).toBe(1);
      expect(attempts).toBe(kind === 'retry' ? 2 : 1);
    },
  );

  it('does not roll back a body write when the callback event commits late', async () => {
    let bodyWritten!: () => void;
    const wroteBody = new Promise<void>((resolve) => {
      bodyWritten = resolve;
    });
    let committed!: () => void;
    const firstNodeEventCommitted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    class CoordinatedSessionService extends InMemorySessionService {
      override async appendEvent(params: AppendEventRequest): Promise<Event> {
        if (params.event.actions.stateDelta.seed === 'from-plugin') {
          await wroteBody;
        }
        const result = await super.appendEvent(params);
        if (params.event.author === 'leaf') committed();
        return result;
      }
    }
    const leaf = node(
      async (ctx: NodeContext) => {
        ctx.state.set('seed', 'from-body');
        bodyWritten();
        ctx.emit(
          createEvent({author: 'leaf', content: {parts: [{text: 'progress'}]}}),
        );
        await firstNodeEventCommitted;
        return ctx.state.get('seed');
      },
      {name: 'leaf'},
    );
    const service = new CoordinatedSessionService();
    const workflow = new Workflow({name: 'wf', edges: [['START', leaf]]});
    const runner = new Runner({
      appName: 'app',
      agent: workflow,
      sessionService: service,
      plugins: [new SeedState(leaf)],
    });
    const session = await service.createSession({appName: 'app', userId: 'u'});
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    }))
      events.push(event);
    expect(
      events.filter((event) => event.output !== undefined).at(-1)?.output,
    ).toBe('from-body');
    expect(
      (
        await service.getSession({
          appName: 'app',
          userId: 'u',
          sessionId: session.id,
        })
      )?.state,
    ).toEqual({seed: 'from-body'});
  });

  it('keeps callback state when the node subsequently fails', async () => {
    const leaf = node(
      () => {
        throw new Error('body failed');
      },
      {name: 'leaf'},
    );
    const runner = new InMemoryRunner({
      appName: 'app',
      agent: new Workflow({name: 'wf', edges: [['START', leaf]]}),
      plugins: [new SeedState(leaf)],
    });
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const events: Event[] = [];
    await expect(
      (async () => {
        for await (const event of runner.runAsync({
          userId: 'u',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text: 'go'}]},
        }))
          events.push(event);
      })(),
    ).rejects.toThrow('body failed');
    expect(
      (
        await runner.sessionService.getSession({
          appName: 'app',
          userId: 'u',
          sessionId: session.id,
        })
      )?.state,
    ).toEqual({seed: 'from-plugin'});
    expect(
      events.filter((event) => event.actions.stateDelta.seed !== undefined),
    ).toHaveLength(1);
  });

  it('does not create an extra completed activation before a pause', async () => {
    let calls = 0;
    const leaf = node(
      () => {
        calls++;
        return 'finished';
      },
      {name: 'leaf'},
    );
    const gate = node(
      (ctx: NodeContext) =>
        ctx.resumeInputs['approve'] ??
        new RequestInput({interruptId: 'approve', message: 'approve?'}),
      {name: 'gate', rerunOnResume: true},
    );
    const plugin = new SeedState(leaf);
    const runner = new InMemoryRunner({
      appName: 'app',
      agent: new Workflow({name: 'wf', edges: [['START', leaf, gate]]}),
      plugins: [plugin],
    });
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      expect(event.errorCode).toBeUndefined();
    }
    const resumed: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'approve',
              name: 'adk_request_input',
              response: {result: 'yes'},
            },
          },
        ],
      },
    }))
      resumed.push(event);
    expect(
      resumed.filter((event) => event.output !== undefined).at(-1)?.output,
    ).toBe('yes');
    expect(calls).toBe(1);
    expect(plugin.calls).toBe(1);
    expect(
      (
        await runner.sessionService.getSession({
          appName: 'app',
          userId: 'u',
          sessionId: session.id,
        })
      )?.state,
    ).toEqual({seed: 'from-plugin'});
  });
});
