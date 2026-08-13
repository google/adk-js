/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  isBaseNode,
  isContent,
  START,
  toContent,
} from '../../src/workflow/base_node.js';
import {node} from '../../src/workflow/node.js';
import {isWorkflow, Workflow} from '../../src/workflow/workflow.js';
import {FnNode} from './test_helpers.js';

describe('isBaseNode', () => {
  it('recognizes node instances and the START sentinel', () => {
    expect(isBaseNode(new FnNode('n', (_c, i) => i))).toBe(true);
    expect(isBaseNode(START)).toBe(true);
  });

  it('rejects non-nodes', () => {
    expect(isBaseNode({})).toBe(false);
    expect(isBaseNode(null)).toBe(false);
    expect(isBaseNode('START')).toBe(false);
  });
});

describe('isWorkflow', () => {
  const workflow = new Workflow({
    name: 'wf',
    edges: [['START', node(() => 'x', {name: 'step'})]],
  });

  it('recognizes a Workflow', () => {
    expect(isWorkflow(workflow)).toBe(true);
    // The brand is an instance field, so it survives the `@experimental`
    // decorator wrapping the class.
    expect(isBaseNode(workflow)).toBe(true);
  });

  it('rejects other nodes and non-nodes', () => {
    expect(isWorkflow(new FnNode('n', (_c, i) => i))).toBe(false);
    expect(isWorkflow(START)).toBe(false);
    expect(isWorkflow({})).toBe(false);
    expect(isWorkflow(null)).toBe(false);
  });
});

describe('isContent', () => {
  it('is true for objects with a parts array', () => {
    expect(isContent({parts: []})).toBe(true);
    expect(isContent({role: 'model', parts: [{text: 'x'}]})).toBe(true);
  });

  it('is false without a parts array', () => {
    expect(isContent({role: 'model'})).toBe(false);
    expect(isContent({parts: 'x'})).toBe(false);
    expect(isContent('x')).toBe(false);
    expect(isContent(null)).toBe(false);
  });
});

describe('toContent', () => {
  const text = (c: Content | undefined) => c?.parts?.[0]?.text;

  it('returns undefined for null / undefined', () => {
    expect(toContent(null)).toBeUndefined();
    expect(toContent(undefined)).toBeUndefined();
  });

  it('passes a Content value through unchanged', () => {
    const content: Content = {role: 'model', parts: [{text: 'hi'}]};
    expect(toContent(content)).toBe(content);
  });

  it('wraps a string into a text part', () => {
    expect(text(toContent('hello'))).toBe('hello');
  });

  it('wraps a Part and an array of Parts', () => {
    expect(text(toContent({text: 'p'}))).toBe('p');
    const many = toContent([{text: 'a'}, {text: 'b'}]);
    expect(many?.parts).toHaveLength(2);
  });

  it('serializes a plain object to JSON text', () => {
    expect(text(toContent({count: 1}))).toBe('{"count":1}');
  });

  it('serializes numbers and booleans to text', () => {
    expect(text(toContent(42))).toBe('42');
    expect(text(toContent(true))).toBe('true');
  });

  it('does not throw on a value JSON cannot serialize (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toContent(circular)).not.toThrow();
    expect(typeof text(toContent(circular))).toBe('string');
  });
});
