/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseTool} from '../../src/tools/base_tool.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
import {
  buildNode,
  isNodeLike,
} from '../../src/workflow/utils/workflow_graph_utils.js';

// Importing the node modules above registers their builders as a side effect;
// these tests verify that self-registration wires buildNode/isNodeLike.

class TestTool extends BaseTool {
  constructor() {
    super({name: 'test_tool', description: 'a tool'});
  }
  async runAsync(): Promise<unknown> {
    return 'ok';
  }
}

/** Returns a function with an empty `.name` (not bound to a variable). */
function anonymousFn(): () => void {
  return () => {};
}

describe('node builder registry', () => {
  it('builds a FunctionNode from a named function', () => {
    function greet() {}
    const node = buildNode(greet);
    expect(node).toBeInstanceOf(FunctionNode);
    expect(node.name).toBe('greet');
  });

  it('uses an explicit name for an anonymous function', () => {
    const node = buildNode(anonymousFn(), {name: 'anon'});
    expect(node).toBeInstanceOf(FunctionNode);
    expect(node.name).toBe('anon');
  });

  it('throws for an unnamed function with no name option', () => {
    expect(() => buildNode(anonymousFn())).toThrow(/no name/i);
  });

  it('builds a ToolNode from a BaseTool', () => {
    const node = buildNode(new TestTool());
    expect(node).toBeInstanceOf(ToolNode);
    expect(node.name).toBe('test_tool');
  });

  it('returns an existing BaseNode as-is', () => {
    const built = buildNode(() => {}, {name: 'x'});
    expect(buildNode(built)).toBe(built);
  });

  it('recognizes functions, tools, and START as node-like', () => {
    expect(isNodeLike(() => {})).toBe(true);
    expect(isNodeLike(new TestTool())).toBe(true);
    expect(isNodeLike('START')).toBe(true);
    expect(isNodeLike({not: 'a node'})).toBe(false);
    expect(isNodeLike(42)).toBe(false);
  });
});
