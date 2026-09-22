/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isWebMCPSupported,
  WebMCPDocument,
  WebMCPRegisteredTool,
  WebMCPToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const REGISTERED: WebMCPRegisteredTool[] = [
  {
    name: 'search_flights',
    description: 'Search flights.',
    inputSchema: {type: 'object', properties: {}},
  },
  {
    name: 'delete_booking',
    description: 'Delete a booking.',
    inputSchema: {type: 'object', properties: {}},
    annotations: {consequentialHint: true},
  },
];

type ToolChangeListener = (event: Event) => void;

function fakeDocument(tools = REGISTERED) {
  const listeners = new Map<string, Set<ToolChangeListener>>();
  const modelContext = {
    getTools: vi.fn(async () => tools),
    executeTool: vi.fn(),
    addEventListener: vi.fn((type: string, fn: ToolChangeListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: ToolChangeListener) => {
      listeners.get(type)?.delete(fn);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    }),
  };
  return {
    doc: {modelContext} as unknown as WebMCPDocument,
    modelContext,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

describe('isWebMCPSupported', () => {
  it('should be false without modelContext', () => {
    expect(isWebMCPSupported({})).toBe(false);
  });

  it('should be true with modelContext', () => {
    expect(isWebMCPSupported(fakeDocument().doc)).toBe(true);
  });
});

describe('WebMCPToolset', () => {
  it('should wrap every registered tool', async () => {
    const {doc} = fakeDocument();
    const tools = await new WebMCPToolset({document: doc}).getTools();

    expect(tools.map((t) => t.name)).toEqual([
      'search_flights',
      'delete_booking',
    ]);
  });

  it('should apply a prefix to tool names', async () => {
    const {doc} = fakeDocument();
    const tools = await new WebMCPToolset({
      document: doc,
      prefix: 'web',
    }).getTools();

    expect(tools.map((t) => t.name)).toEqual([
      'web_search_flights',
      'web_delete_booking',
    ]);
  });

  it('should apply an allowlist filter, matching prefixed names', async () => {
    const {doc} = fakeDocument();
    const tools = await new WebMCPToolset({
      document: doc,
      prefix: 'web',
      toolFilter: ['web_search_flights'],
    }).getTools();

    expect(tools.map((t) => t.name)).toEqual(['web_search_flights']);
  });

  it('should forward fromOrigins to getTools', async () => {
    const {doc, modelContext} = fakeDocument();
    await new WebMCPToolset({
      document: doc,
      fromOrigins: ['https://partner.example'],
    }).getTools();

    expect(modelContext.getTools).toHaveBeenCalledWith({
      fromOrigins: ['https://partner.example'],
    });
  });

  it('should carry the consequential annotation onto the tool', async () => {
    const {doc} = fakeDocument();
    const tools = await new WebMCPToolset({document: doc}).getTools();
    const consequential = tools.find((t) => t.name === 'delete_booking')!;

    await expect(consequential.checkRequireConfirmation({})).resolves.toBe(
      true,
    );
  });

  it('should return no tools when WebMCP is unavailable', async () => {
    const toolset = new WebMCPToolset({document: {}});

    expect(toolset.isSupported()).toBe(false);
    await expect(toolset.getTools()).resolves.toEqual([]);
  });

  it('should notify subscribers of toolchange and allow unsubscribing', async () => {
    const {doc, modelContext, listenerCount} = fakeDocument();
    const toolset = new WebMCPToolset({document: doc});
    const onChange = vi.fn();

    const unsubscribe = toolset.onToolChange(onChange);
    modelContext.dispatchEvent(new Event('toolchange'));
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    modelContext.dispatchEvent(new Event('toolchange'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(listenerCount('toolchange')).toBe(0);
  });

  it('should detach remaining listeners on close', async () => {
    const {doc, listenerCount} = fakeDocument();
    const toolset = new WebMCPToolset({document: doc});

    toolset.onToolChange(vi.fn());
    toolset.onToolChange(vi.fn());
    expect(listenerCount('toolchange')).toBe(2);

    await toolset.close();
    expect(listenerCount('toolchange')).toBe(0);
  });
});
