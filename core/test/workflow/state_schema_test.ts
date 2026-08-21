/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {createEvent} from '../../src/events/event.js';
import {isStateSchemaError, State} from '../../src/sessions/state.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow, replyAgent} from './test_helpers.js';

/** The same shape in every dialect ADK accepts, so each is held to it. */
const dialects = {
  'Zod v4': z4.object({
    counter: z4.number(),
    label: z4.string(),
    note: z4.string().nullable(),
  }),
  'Zod v3': z3.object({
    counter: z3.number(),
    label: z3.string(),
    note: z3.string().nullable(),
  }),
  'genai Schema': {
    type: Type.OBJECT,
    properties: {
      counter: {type: Type.NUMBER},
      label: {type: Type.STRING},
      note: {type: Type.STRING, nullable: true},
    },
  } as Schema,
} as const;

/** The dialect the plumbing tests use; enforcement is covered for all three. */
const schema = dialects['Zod v4'];

describe.each(Object.entries(dialects))(
  'State schema — %s',
  (_name, schema) => {
    const stateWithSchema = () => new State({}, {}, schema);

    it('rejects an undeclared key', () => {
      const state = stateWithSchema();
      expect(() => state.set('nope', 1)).toThrow(
        /not declared in the state schema/,
      );
      try {
        state.set('nope', 1);
      } catch (err) {
        expect(isStateSchemaError(err)).toBe(true);
        // The message names what is allowed, so the fix is obvious.
        expect((err as Error).message).toContain('counter');
      }
    });

    it('accepts a declared key', () => {
      const state = stateWithSchema();
      state.set('counter', 7);
      expect(state.get('counter')).toBe(7);
    });

    it('rejects a value of the wrong type', () => {
      const state = stateWithSchema();
      expect(() => state.set('counter', 'seven')).toThrow(
        /does not match the type declared/,
      );
    });

    it('accepts null for a nullable field', () => {
      const state = stateWithSchema();
      state.set('note', null);
      expect(state.get('note')).toBeNull();
    });

    it('never validates prefixed keys', () => {
      const state = stateWithSchema();
      for (const key of ['app:x', 'user:y', 'temp:z', 'other:w']) {
        state.set(key, {anything: true});
        expect(state.get(key)).toEqual({anything: true});
      }
    });

    it('validates every key of an update()', () => {
      const state = stateWithSchema();
      expect(() => state.update({counter: 1, nope: 2})).toThrow(
        /not declared in the state schema/,
      );
      state.update({counter: 1, label: 'ok'});
      expect(state.get('label')).toBe('ok');
    });
  },
);

describe('State schema — dialect-independent behaviour', () => {
  it('allows anything when no schema is declared', () => {
    const state = new State({}, {});
    state.set('whatever', {deeply: {nested: true}});
    expect(state.get('whatever')).toEqual({deeply: {nested: true}});
  });

  it('leaves a non-object schema unenforced rather than rejecting writes', () => {
    for (const nonObject of [z4.string(), z3.string()]) {
      const state = new State({}, {}, nonObject);
      state.set('anything', 1);
      expect(state.get('anything')).toBe(1);
    }
  });
});

describe('Workflow-level state schema', () => {
  it('defaults to undefined', () => {
    const wf = new Workflow({
      name: 'no_schema',
      edges: [['START', new FunctionNode('n', () => 'x')]],
    });
    expect(wf.stateSchema).toBeUndefined();
  });

  it('accepts writes that match', async () => {
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('counter', 1);
      ctx.state.set('label', 'hello');
      return 'done';
    });
    const wf = new Workflow({
      name: 'valid',
      stateSchema: schema,
      edges: [['START', write]],
    });
    const {output} = await driveWorkflow(wf, 'x');
    expect(output).toBe('done');
  });

  it('rejects an undeclared key written through ctx.state', async () => {
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('undeclared', 1);
      return 'done';
    });
    const wf = new Workflow({
      name: 'bad_key',
      stateSchema: schema,
      edges: [['START', write]],
    });
    await expect(driveWorkflow(wf, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });

  it('rejects an undeclared key carried on an emitted event', async () => {
    const write = new FunctionNode('write', function* () {
      yield createEvent({output: 'done', actions: {stateDelta: {nope: 1}}});
    });
    const wf = new Workflow({
      name: 'bad_event_key',
      stateSchema: schema,
      edges: [['START', write]],
    });
    await expect(driveWorkflow(wf, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });

  it('accepts a declared key carried on an emitted event', async () => {
    const write = new FunctionNode('write', function* () {
      yield createEvent({output: 'done', actions: {stateDelta: {counter: 3}}});
    });
    const wf = new Workflow({
      name: 'good_event_key',
      stateSchema: schema,
      edges: [['START', write]],
    });
    const {output} = await driveWorkflow(wf, 'x');
    expect(output).toBe('done');
  });

  it('allows prefixed keys at runtime', async () => {
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('app:anything', {free: 'form'});
      ctx.state.set('temp:scratch', 42);
      return 'done';
    });
    const wf = new Workflow({
      name: 'prefixed',
      stateSchema: schema,
      edges: [['START', write]],
    });
    expect((await driveWorkflow(wf, 'x')).output).toBe('done');
  });

  it('allows anything when the workflow declares no schema', async () => {
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('anything', 'goes');
      return 'done';
    });
    const wf = new Workflow({
      name: 'unschemad',
      edges: [['START', write]],
    });
    expect((await driveWorkflow(wf, 'x')).output).toBe('done');
  });

  it('enforces a Zod v3 schema end to end', async () => {
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('undeclared', 1);
      return 'done';
    });
    const wf = new Workflow({
      name: 'v3_workflow',
      stateSchema: dialects['Zod v3'],
      edges: [['START', write]],
    });
    await expect(driveWorkflow(wf, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });

  it('enforces a genai Schema end to end', async () => {
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('counter', 'not a number');
      return 'done';
    });
    const wf = new Workflow({
      name: 'genai_workflow',
      stateSchema: dialects['genai Schema'],
      edges: [['START', write]],
    });
    await expect(driveWorkflow(wf, 'x')).rejects.toThrow(
      /does not match the type declared/,
    );
  });
});

describe('Node-level state schema and inheritance', () => {
  const nodeSchema = z4.object({nodeKey: z4.string()});

  it('validates writes against a schema declared on the node', async () => {
    const write = new FunctionNode(
      'write',
      (ctx: NodeContext) => {
        ctx.state.set('counter', 1);
        return 'done';
      },
      {stateSchema: nodeSchema},
    );
    const wf = new Workflow({name: 'node_schema', edges: [['START', write]]});
    await expect(driveWorkflow(wf, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });

  it('accepts writes that match the node schema', async () => {
    const write = new FunctionNode(
      'write',
      (ctx: NodeContext) => {
        ctx.state.set('nodeKey', 'ok');
        return 'done';
      },
      {stateSchema: nodeSchema},
    );
    const wf = new Workflow({name: 'node_ok', edges: [['START', write]]});
    expect((await driveWorkflow(wf, 'x')).output).toBe('done');
  });

  it('lets a node schema override the workflow schema', async () => {
    // `nodeKey` is not in the workflow schema, and `counter` is not in the
    // node's — the node answers only to its own.
    const write = new FunctionNode(
      'write',
      (ctx: NodeContext) => {
        ctx.state.set('nodeKey', 'ok');
        return 'done';
      },
      {stateSchema: nodeSchema},
    );
    const wf = new Workflow({
      name: 'override',
      stateSchema: schema,
      edges: [['START', write]],
    });
    expect((await driveWorkflow(wf, 'x')).output).toBe('done');
  });

  it('inherits the workflow schema when the node declares none', async () => {
    const good = new FunctionNode('good', (ctx: NodeContext) => {
      ctx.state.set('counter', 1);
      return 'ok';
    });
    const bad = new FunctionNode('bad', (ctx: NodeContext) => {
      ctx.state.set('nodeKey', 'x');
      return 'ok';
    });
    const okWf = new Workflow({
      name: 'inherit_ok',
      stateSchema: schema,
      edges: [['START', good]],
    });
    expect((await driveWorkflow(okWf, 'x')).output).toBe('ok');

    const badWf = new Workflow({
      name: 'inherit_bad',
      stateSchema: schema,
      edges: [['START', bad]],
    });
    await expect(driveWorkflow(badWf, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });

  it('rejects an undeclared outputKey written by an agent node', async () => {
    const agent = replyAgent('writer', 'hi', {outputKey: 'undeclaredKey'});
    const wf = new Workflow({
      name: 'agent_output_key',
      stateSchema: schema,
      edges: [['START', agent]],
    });
    await expect(driveWorkflow(wf, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });

  it('accepts a declared outputKey written by an agent node', async () => {
    const agent = replyAgent('writer', 'hi', {outputKey: 'label'});
    const wf = new Workflow({
      name: 'agent_output_key_ok',
      stateSchema: schema,
      edges: [['START', agent]],
    });
    expect((await driveWorkflow(wf, 'x')).output).toBe('hi');
  });

  it('inherits through a nested workflow', async () => {
    const inner = new FunctionNode('inner', (ctx: NodeContext) => {
      ctx.state.set('undeclared', 1);
      return 'ok';
    });
    const innerWf = new Workflow({
      name: 'inner_wf',
      edges: [['START', inner]],
    });
    const outer = new Workflow({
      name: 'outer_wf',
      stateSchema: schema,
      edges: [['START', innerWf]],
    });
    await expect(driveWorkflow(outer, 'x')).rejects.toThrow(
      /not declared in the state schema/,
    );
  });
});
