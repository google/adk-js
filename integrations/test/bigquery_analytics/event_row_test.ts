/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type BaseAgent,
  Context,
  createEvent,
  type InvocationContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  resolveModelName,
  snakeCaseSchema,
  strictAncestorNodePaths,
} from '../../src/bigquery_analytics/callback_support.js';
import {resolveLoggerConfig} from '../../src/bigquery_analytics/config.js';
import {type HybridContentParser} from '../../src/bigquery_analytics/content_parser.js';
import {
  buildEventRow,
  nodeRunIds,
  parseContent,
  type RowSettings,
  scopeOf,
} from '../../src/bigquery_analytics/event_row.js';
import {TraceManager} from '../../src/bigquery_analytics/trace_manager.js';
import {
  type ContentPart,
  type JsonValue,
} from '../../src/bigquery_analytics/types.js';

function settings(): RowSettings {
  return {
    config: resolveLoggerConfig(),
    deniedColumns: new Set(),
    customMetadata: {exact: new Set(), prefixes: []},
    traces: new TraceManager(),
  };
}

function contextWith(fields: Partial<InvocationContext> = {}): Context {
  const invocationContext = {
    invocationId: 'inv',
    session: {id: 's', appName: 'app', userId: 'u', state: {}, events: []},
    ...fields,
  } as unknown as InvocationContext;
  return new Context({invocationContext});
}

const PREPARED = {
  timestamp: new Date(0),
  content: null,
  errorMessage: null,
  isTruncated: false,
  formatterFailed: false,
};

const PARSED = {
  content: null,
  parts: [],
  isTruncated: false,
  parseFailed: false,
};

describe('node paths', () => {
  it.each([
    ['wf@one.child@two', {run_id: 'two', parent_run_id: 'one'}],
    ['wf@one.child', {run_id: '', parent_run_id: 'one'}],
    ['wf@1.dyn@2.static', {run_id: '', parent_run_id: '2'}],
    ['wf@1.a@2.b@3', {run_id: '3', parent_run_id: '2'}],
    ['wf.step', {run_id: '', parent_run_id: null}],
    ['wf@1', {run_id: '1', parent_run_id: null}],
    ['', {run_id: '', parent_run_id: null}],
  ])('parses run ids from %s', (path, expected) => {
    expect(nodeRunIds(path)).toEqual(expected);
  });

  it('lists strict ancestors from the root', () => {
    expect(strictAncestorNodePaths('wf@1.a@2.b')).toEqual(['wf@1', 'wf@1.a@2']);
    expect(strictAncestorNodePaths('wf')).toEqual([]);
  });

  it('classifies a dot-separated isolation scope as a node run', () => {
    const row = buildEventRow({
      eventType: 'NODE_OUTPUT',
      context: contextWith(),
      eventData: {
        sourceEvent: {
          ...createEvent({author: 'b'}),
          isolationScope: 'wf@1.b@2',
        },
      },
      ids: {traceId: null, spanId: null, parentSpanId: null},
      prepared: PREPARED,
      parsed: PARSED,
      settings: settings(),
    });
    const adk = (row.attributes as {adk: {scope: unknown}}).adk;
    expect(adk.scope).toEqual({id: 'wf@1.b@2', kind: 'node_run'});
  });
});

describe('buildEventRow', () => {
  it('labels a runner event with its author, and a user event with the agent', () => {
    const context = contextWith({agent: {name: 'root'} as BaseAgent});
    const build = (author: string) =>
      buildEventRow({
        eventType: 'STATE_DELTA',
        context,
        eventData: {sourceEvent: createEvent({author})},
        ids: {traceId: null, spanId: null, parentSpanId: null},
        prepared: PREPARED,
        parsed: PARSED,
        settings: settings(),
      }).agent;
    expect(build('sub_agent')).toBe('sub_agent');
    expect(build('user')).toBe('root');
  });

  it('writes a row when the session is missing', () => {
    const context = contextWith();
    (context.invocationContext as {session: unknown}).session = undefined;
    const row = buildEventRow({
      eventType: 'LLM_REQUEST',
      context,
      eventData: {},
      ids: {traceId: null, spanId: null, parentSpanId: null},
      prepared: PREPARED,
      parsed: PARSED,
      settings: settings(),
    });
    expect(row.user_id).toBeNull();
    expect(row.session_id).toBeNull();
  });

  it('scopes a runner event by its own branch when the context has none', () => {
    const event = createEvent({author: 'a', branch: 'root.a'});
    expect(scopeOf(contextWith(), event).branch).toBe('root.a');
    expect(scopeOf(contextWith({branch: 'root.b'}), event).branch).toBe(
      'root.b',
    );
  });
});

describe('parseContent', () => {
  it('returns the normalized parts', async () => {
    const part: ContentPart = {
      mime_type: null,
      uri: 'gs://bucket/object',
      object_ref: {
        uri: 'gs://bucket/object',
        version: null,
        authorizer: null,
        details: {
          access_token: 'PART-SECRET',
          size: 10n,
        } as unknown as JsonValue,
      },
      text: null,
      part_index: 0,
      part_attributes: null,
      storage_mode: 'GCS_REFERENCE',
    };
    const parser = {
      parse: async () => ({payload: null, parts: [part], isTruncated: false}),
    } as unknown as HybridContentParser;
    const parsed = await parseContent({
      eventType: 'USER_MESSAGE_RECEIVED',
      content: null,
      ids: {traceId: 't', spanId: 's', parentSpanId: null},
      parser,
      settings: settings(),
    });
    expect(parsed.parts[0]?.object_ref?.details).toEqual({
      access_token: '[REDACTED]',
      size: 10,
    });
  });
});

describe('callback support', () => {
  it('walks parentAgent when the agent has no model of its own', () => {
    const parent = {name: 'parent', model: 'gemini-2.5-flash'};
    const child = {name: 'child', parentAgent: parent} as unknown as BaseAgent;
    expect(resolveModelName(child)).toBe('gemini-2.5-flash');
  });

  it('snake-cases schema keywords but keeps value-bearing ones as written', () => {
    expect(
      snakeCaseSchema({
        type: 'OBJECT',
        maxItems: '2',
        JSONSchema: 'x',
        default: {myKey: 1},
        example: {otherKey: 2},
        enum: ['camelValue'],
        $defs: {myDef: {minLength: 1}},
        properties: {userId: {type: 'STRING', maxLength: '5'}},
      }),
    ).toEqual({
      type: 'OBJECT',
      max_items: '2',
      json_schema: 'x',
      default: {myKey: 1},
      example: {otherKey: 2},
      enum: ['camelValue'],
      $defs: {myDef: {minLength: 1}},
      properties: {userId: {type: 'STRING', max_length: '5'}},
    });
  });
});
