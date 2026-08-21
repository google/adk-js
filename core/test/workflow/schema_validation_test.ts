/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  isNodeSchemaValidationError,
  NodeSchemaValidationError,
} from '../../src/workflow/errors.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {driveNode} from './test_helpers.js';

describe('node schema validation', () => {
  it('validates input against inputSchema', async () => {
    const node = new FunctionNode('squared', (_c, n: number) => n * n, {
      inputSchema: z.number(),
    });
    expect((await driveNode(node, 5)).output).toBe(25);
    await expect(driveNode(node, 'not-a-number')).rejects.toThrow();
  });

  it('validates output against outputSchema', async () => {
    const schema = z.object({total: z.number()});
    const good = new FunctionNode('g', () => ({total: 10}), {
      outputSchema: schema,
    });
    expect((await driveNode(good)).output).toEqual({total: 10});

    const bad = new FunctionNode('b', () => ({total: 'oops'}), {
      outputSchema: schema,
    });
    await expect(driveNode(bad)).rejects.toThrow();
  });

  it('names the failing node and side when input validation fails', async () => {
    // A bare ZodError names the field but not the node, which leaves the
    // failure unattributed in a graph of any size.
    const node = new FunctionNode('squared', (_c, n: number) => n * n, {
      inputSchema: z.number(),
    });
    try {
      await driveNode(node, 'not-a-number');
      expect.unreachable('expected a NodeSchemaValidationError');
    } catch (e) {
      expect(isNodeSchemaValidationError(e)).toBe(true);
      const err = e as NodeSchemaValidationError;
      expect(err.nodeName).toBe('squared');
      expect(err.direction).toBe('input');
      expect(err.message).toContain("Node 'squared'");
      expect(err.message).toContain('inputSchema');
      // The wrapper's promise: the original error survives, and its detail is
      // still in the message.
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.message).toContain((err.cause as Error).message);
    }
  });

  it('names the failing node and side when output validation fails', async () => {
    const bad = new FunctionNode('totals', () => ({total: 'oops'}), {
      outputSchema: z.object({total: z.number()}),
    });
    try {
      await driveNode(bad);
      expect.unreachable('expected a NodeSchemaValidationError');
    } catch (e) {
      expect(isNodeSchemaValidationError(e)).toBe(true);
      const err = e as NodeSchemaValidationError;
      expect(err.nodeName).toBe('totals');
      expect(err.direction).toBe('output');
      expect(err.message).toContain("Node 'totals'");
      expect(err.message).toContain('outputSchema');
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.message).toContain((err.cause as Error).message);
    }
  });

  it('coerces and validates a valid input, passing it to the handler', async () => {
    let received: unknown;
    const node = new FunctionNode(
      'capture',
      (_c, value: {name: string}) => {
        received = value;
        return value.name;
      },
      {inputSchema: z.object({name: z.string()})},
    );
    expect((await driveNode(node, {name: 'ada'})).output).toBe('ada');
    expect(received).toEqual({name: 'ada'});
  });
});
