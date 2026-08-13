/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  CONTENT_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getContents,
  getCurrentTurnContents,
} from '../../src/agents/processors/content_processor_utils.js';
import {createEvent, Event} from '../../src/events/event.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveNode} from './test_helpers.js';

function userEvent(text: string, isolationScope?: string): Event {
  return createEvent({
    author: 'user',
    invocationId: 'inv-1',
    content: {role: 'user', parts: [{text}]},
    isolationScope,
  });
}

function textsOf(contents: Array<{parts?: Array<{text?: string}>}>): string[] {
  return contents.flatMap((c) => (c.parts ?? []).map((p) => p.text ?? ''));
}

describe('isolation scope — content filtering', () => {
  const events = [
    userEvent('shared'),
    userEvent('mine', 'scope-a'),
    userEvent('theirs', 'scope-b'),
  ];

  it('shows an unscoped reader only untagged events', () => {
    expect(textsOf(getContents(events, 'agent'))).toEqual(['shared']);
  });

  it('shows a scoped reader its own events plus untagged ones', () => {
    expect(textsOf(getContents(events, 'agent', undefined, 'scope-a'))).toEqual(
      ['shared', 'mine'],
    );
    expect(textsOf(getContents(events, 'agent', undefined, 'scope-b'))).toEqual(
      ['shared', 'theirs'],
    );
  });

  it('applies the same rule to current-turn contents', () => {
    const turn = getCurrentTurnContents(events, 'agent', undefined, 'scope-a');
    expect(textsOf(turn)).toEqual(['mine']);
  });
});

describe('isolation scope — node plumbing', () => {
  it('derives a per-run scope when a node declares isolationScope: true', async () => {
    const isolated = node(() => 'done', {
      name: 'isolated',
      isolationScope: true,
    });

    const {events} = await driveNode(isolated, 'in');

    expect(events).toHaveLength(1);
    expect(events[0].isolationScope).toBe('isolated@isolated');
  });

  it('stamps an explicit scope tag verbatim', async () => {
    const tagged = node(() => 'done', {
      name: 'tagged',
      isolationScope: 'review-thread',
    });

    const {events} = await driveNode(tagged, 'in');

    expect(events[0].isolationScope).toBe('review-thread');
  });

  it('leaves events untagged by default', async () => {
    const plain = node(() => 'done', {name: 'plain'});

    const {events} = await driveNode(plain, 'in');

    expect(events[0].isolationScope).toBeUndefined();
  });

  it('propagates the scope to the running agent invocation context and to children', async () => {
    const seen: Array<string | undefined> = [];
    const child = node(
      async (ctx: NodeContext) => {
        seen.push(ctx.invocationContext.isolationScope);
        return 'child';
      },
      {name: 'child'},
    );
    const parent = node(
      async (ctx: NodeContext) => {
        seen.push(ctx.invocationContext.isolationScope);
        await ctx.runNode(child, 'x');
        return 'parent';
      },
      {name: 'parent', isolationScope: 'shared-tag'},
    );

    await driveNode(parent, 'in');

    expect(seen).toEqual(['shared-tag', 'shared-tag']);
  });

  it('keeps sibling nodes in separate scopes', async () => {
    const a = node(() => 'a', {name: 'a', isolationScope: true});
    const b = node(() => 'b', {name: 'b', isolationScope: true});
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', a, join],
        ['START', b, join],
      ],
    });

    const {events} = await driveNode(wf, 'in');

    const scopes = events
      .filter((e) => e.author === 'a' || e.author === 'b')
      .map((e) => e.isolationScope);
    expect(new Set(scopes).size).toBe(2);
    expect(scopes).toContain('wf.a@1');
    expect(scopes).toContain('wf.b@1');
  });
});

describe('isolation scope — end to end through the content processor', () => {
  async function contentsFor(
    events: Event[],
    isolationScope?: string,
  ): Promise<string[]> {
    const session = {
      id: 's',
      events,
      appName: 'app',
      userId: 'u',
    } as unknown as Session;
    const ic = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({
        name: 'reviewer',
        model: 'gemini-2.5-flash',
      }) as BaseAgent,
      session,
      pluginManager: new PluginManager([]),
      isolationScope,
    });
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(ic, request)) {
      // drain
    }
    return textsOf(request.contents);
  }

  it('withholds another node conversation from an isolated agent', async () => {
    const events = [
      userEvent('the original question'),
      userEvent('draft the summary', 'wf.writer@1'),
      userEvent('critique the summary', 'wf.critic@1'),
    ];

    expect(await contentsFor(events, 'wf.critic@1')).toEqual([
      'the original question',
      'critique the summary',
    ]);
  });

  it('leaves an agent outside any scope seeing only shared history', async () => {
    const events = [
      userEvent('the original question'),
      userEvent('draft the summary', 'wf.writer@1'),
    ];

    expect(await contentsFor(events)).toEqual(['the original question']);
  });
});
