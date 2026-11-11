/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python parity set for Vertex AI RAG retrieval.
 *
 * Source: adk-python `tests/unittests/tools/retrieval/
 * test_vertex_ai_rag_retrieval.py` at ref `v0.1.0`. Each `it(...)` keeps the
 * Python test function name verbatim so the two suites can be diffed by name.
 *
 * adk-js covers Vertex AI RAG with `VertexRagRetrievalTool`, a `BuiltInTool`
 * that always configures server-side retrieval. adk-python v0.1.0's
 * `VertexAiRagRetrieval` instead switches on the model: Gemini 2 gets the
 * built-in retrieval config, everything else gets a client-side function
 * declaration. Nothing in adk-js is changed to match, so where the two differ
 * the assertion below records what adk-js does and a DIVERGENCE comment
 * states what v0.1.0 asserted instead.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  VertexRagRetrievalTool,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const RAG_CORPUS =
  'projects/123456789/locations/us-central1/ragCorpora/1234567890';

/**
 * adk-python's `utils.MockModel`: answers with canned text and keeps every
 * request it was given.
 */
class MockModel extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(
    model: string,
    private readonly responses: string[],
  ) {
    super({model});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const text = this.responses[this.requests.length - 1] ?? 'response';
    yield {content: {role: 'model', parts: [{text}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('The parity tests never open a live connection.');
  }
}

/** adk-python's `utils.simplify_contents`. */
function simplifyContents(request: LlmRequest): Array<[string, string]> {
  return (request.contents ?? []).map((content) => [
    content.role ?? '',
    (content.parts ?? []).map((part) => part.text ?? '').join(''),
  ]);
}

/** adk-python's `noop_tool`. */
function noopTool(): BaseTool {
  return new FunctionTool({
    name: 'noop_tool',
    description: 'noop_tool',
    parameters: z.object({x: z.string()}),
    execute: async ({x}) => x,
  });
}

/** The tool under test, with the corpus the Python tests use. */
function ragRetrieval(): VertexRagRetrievalTool {
  // DIVERGENCE: v0.1.0 constructs
  // `VertexAiRagRetrieval(name='rag_retrieval', description='rag_retrieval',
  // rag_corpora=[...])`. `VertexRagRetrievalTool` takes only the
  // `VertexRagStore` and fixes its name to `vertex_rag_retrieval`, so every
  // name below reads `vertex_rag_retrieval` where Python read
  // `rag_retrieval`.
  return new VertexRagRetrievalTool({ragCorpora: [RAG_CORPUS]});
}

/** adk-python's `utils.InMemoryRunner(agent).run('test1')`. */
async function runOnce(
  model: MockModel,
  tools: LlmAgent['tools'],
): Promise<Event[]> {
  const agent = new LlmAgent({name: 'root_agent', model, tools});
  const runner = new InMemoryRunner({agent, appName: 'parity_app'});
  const session = await runner.sessionService.createSession({
    appName: 'parity_app',
    userId: 'user',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'test1'}]},
  })) {
    events.push(event);
  }
  return events;
}

/** `config.tools` is a `ToolUnion[]`; only plain `Tool`s are produced here. */
function toolsOf(request: LlmRequest): Tool[] {
  return (request.config?.tools ?? []) as Tool[];
}

describe('vertex_ai_rag_retrieval (adk-python v0.1.0 parity)', () => {
  it('test_vertex_rag_retrieval_for_gemini_1_x', async () => {
    const mockModel = new MockModel('gemini-1.5-pro', ['response1']);

    await runOnce(mockModel, [ragRetrieval()]);

    expect(mockModel.requests).toHaveLength(1);
    expect(simplifyContents(mockModel.requests[0])).toEqual([
      ['user', 'test1'],
    ]);
    expect(toolsOf(mockModel.requests[0])).toHaveLength(1);

    // DIVERGENCE: v0.1.0 asserts
    // `config.tools[0].function_declarations[0].name == 'rag_retrieval'` —
    // a non-Gemini-2 model gets the client-side function declaration.
    // `VertexRagRetrievalTool` has no model gating and no client-side path,
    // so it configures server-side retrieval for every model.
    expect(toolsOf(mockModel.requests[0])[0]).toEqual({
      retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}},
    });
    expect(
      toolsOf(mockModel.requests[0])[0].functionDeclarations,
    ).toBeUndefined();

    // v0.1.0 asserts `tools_dict['rag_retrieval'] is not None`; the entry is
    // present here too, under adk-js's fixed tool name.
    expect(
      mockModel.requests[0].toolsDict['vertex_rag_retrieval'],
    ).toBeDefined();
  });

  it('test_vertex_rag_retrieval_for_gemini_1_x_with_another_function_tool', async () => {
    const mockModel = new MockModel('gemini-1.5-pro', ['response1']);

    await runOnce(mockModel, [ragRetrieval(), noopTool()]);

    expect(mockModel.requests).toHaveLength(1);
    expect(simplifyContents(mockModel.requests[0])).toEqual([
      ['user', 'test1'],
    ]);

    // DIVERGENCE: v0.1.0 asserts a single tool entry carrying two function
    // declarations, `['rag_retrieval', 'noop_tool']`, because both tools take
    // the declaration path on Gemini 1.x. In adk-js the retrieval tool is
    // server-side, so it occupies its own entry and only `noop_tool` is
    // declared.
    const tools = toolsOf(mockModel.requests[0]);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}},
    });
    expect(tools[1].functionDeclarations?.map((d) => d.name)).toEqual([
      'noop_tool',
    ]);

    expect(
      mockModel.requests[0].toolsDict['vertex_rag_retrieval'],
    ).toBeDefined();
  });

  it('test_vertex_rag_retrieval_for_gemini_2_x', async () => {
    const mockModel = new MockModel('gemini-2.0-flash', ['response1']);

    await runOnce(mockModel, [ragRetrieval()]);

    expect(mockModel.requests).toHaveLength(1);
    expect(simplifyContents(mockModel.requests[0])).toEqual([
      ['user', 'test1'],
    ]);

    // Matches v0.1.0 exactly: on Gemini 2 both implementations send the
    // built-in retrieval config and nothing else.
    expect(toolsOf(mockModel.requests[0])).toEqual([
      {retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}}},
    ]);

    // DIVERGENCE: v0.1.0 asserts `'rag_retrieval' not in tools_dict` — its
    // Gemini 2 branch skips `BaseTool.process_llm_request` entirely, so the
    // tool is never registered. adk-js registers every `BuiltInTool` by name
    // on purpose (google/adk-js#789): a model that returns the tool as an
    // explicit function call would otherwise produce a call the framework
    // cannot route.
    expect(
      mockModel.requests[0].toolsDict['vertex_rag_retrieval'],
    ).toBeDefined();
  });
});
