/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentResponse,
  PartialArg,
  Type,
} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {
  FeatureName,
  isFeatureEnabled,
  withTemporaryFeatureOverride,
} from '../../src/features/feature_registry.js';
import {Gemini} from '../../src/models/google_llm.js';
import {appendTools, LlmRequest} from '../../src/models/llm_request.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {BaseTool} from '../../src/tools/base_tool.js';
import {FunctionTool} from '../../src/tools/function_tool.js';

function partialCall(partialArgs: PartialArg[], id = 'call'): FunctionCall {
  return {id, name: 'collect', partialArgs, willContinue: false};
}

async function stream(
  calls: FunctionCall[],
  progressive = true,
  tool?: BaseTool,
) {
  const model = new Gemini({
    vertexai: true,
    project: 'local-test-project',
    location: 'us-central1',
  });
  const chunks = calls.map((call) => {
    const response = new GenerateContentResponse();
    response.candidates = [
      {
        content: {role: 'model', parts: [{functionCall: call}]},
        finishReason: FinishReason.STOP,
      },
    ];
    return response;
  });
  let sdkCalls = 0;
  let declarations: FunctionDeclaration[] | undefined;
  Object.defineProperty(model, 'apiClient', {
    value: {
      vertexai: true,
      models: {
        async generateContentStream(params: {
          config?: {
            tools?: Array<{functionDeclarations?: FunctionDeclaration[]}>;
          };
        }) {
          sdkCalls++;
          declarations = params.config?.tools?.[0].functionDeclarations;
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  });
  const request: LlmRequest = {
    contents: [{role: 'user', parts: [{text: 'collect'}]}],
    toolsDict: {},
    liveConnectConfig: {},
  };
  if (tool) appendTools(request, [tool]);
  const feature = FeatureName.PROGRESSIVE_SSE_STREAMING;
  const before = isFeatureEnabled(feature);
  const result: FunctionCall[] = [];
  try {
    await withTemporaryFeatureOverride(feature, progressive, async () => {
      for await (const response of model.generateContentAsync(request, true)) {
        if (!response.partial) {
          for (const part of response.content?.parts ?? []) {
            if (part.functionCall) result.push(part.functionCall);
          }
        }
      }
    });
  } finally {
    expect(isFeatureEnabled(feature)).toBe(before);
  }
  expect(sdkCalls).toBe(1);
  return {calls: result, model, declarations};
}

describe('Vertex progressive streamed array arguments', () => {
  it('reconstructs declared arrays and executes a real FunctionTool once', async () => {
    const expected = {items: [{name: 'alpha'}, {name: 'beta'}]};
    let executions = 0;
    let received: unknown;
    const tool = new FunctionTool({
      name: 'collect',
      description: 'Collects names',
      parameters: z.object({items: z.array(z.object({name: z.string()}))}),
      execute: (args) => {
        executions++;
        received = args;
        return {count: args.items.length};
      },
    });
    const {calls, model, declarations} = await stream(
      [
        partialCall([
          {jsonPath: '$.items[0].name', stringValue: 'alpha'},
          {jsonPath: '$.items[1].name', stringValue: 'beta'},
        ]),
      ],
      true,
      tool,
    );
    expect(declarations?.[0].parameters?.properties?.['items'].type).toBe(
      Type.ARRAY,
    );
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0].args?.['items'])).toBe(true);
    expect(calls[0].args).toEqual(expected);
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test',
        agent: new LlmAgent({name: 'agent', model}),
        session: createSession({id: 'session', appName: 'app', userId: 'user'}),
        pluginManager: new PluginManager([]),
      }),
    });
    expect(
      await tool.runAsync({args: calls[0].args ?? {}, toolContext: context}),
    ).toEqual({count: 2});
    expect(received).toEqual(expected);
    expect(executions).toBe(1);
  });

  it.each(["$.items['0'].name", '$.items["0"].name'])(
    'keeps the quoted numeric object member in %s',
    async (jsonPath) => {
      const {calls} = await stream([
        partialCall([{jsonPath, stringValue: 'alpha'}]),
      ]);
      expect(calls[0].args).toEqual({items: {'0': {name: 'alpha'}}});
      expect(Array.isArray(calls[0].args?.['items'])).toBe(false);
    },
  );

  it.each([true, false])(
    'preserves complete array args with progressive=%s',
    async (progressive) => {
      const args = {items: [{name: 'alpha'}]};
      const {calls} = await stream(
        [{id: 'call', name: 'collect', args}],
        progressive,
      );
      expect(calls[0].args).toEqual(args);
    },
  );

  it('reconstructs nested arrays', async () => {
    const {calls} = await stream([
      partialCall([
        {jsonPath: '$.matrix[0][0]', numberValue: 1},
        {jsonPath: '$.matrix[0][1]', numberValue: 2},
        {jsonPath: '$.matrix[1][0]', numberValue: 3},
      ]),
    ]);
    expect(calls[0].args).toEqual({matrix: [[1, 2], [3]]});
  });

  it('appends string chunks at the same array element', async () => {
    const first = partialCall([{jsonPath: '$.items[0]', stringValue: 'al'}]);
    first.willContinue = true;
    const last: FunctionCall = {
      id: 'call',
      willContinue: false,
      partialArgs: [{jsonPath: '$.items[0]', stringValue: 'pha'}],
    };
    const {calls} = await stream([first, last]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({items: ['alpha']});
  });

  it('preserves false, zero, null and empty string in array elements', async () => {
    const {calls} = await stream([
      partialCall([
        {jsonPath: '$.items[0]', boolValue: false},
        {jsonPath: '$.items[1]', numberValue: 0},
        {jsonPath: '$.items[2]', nullValue: 'NULL_VALUE'},
        {jsonPath: '$.items[3]', stringValue: ''},
      ]),
    ]);
    expect(calls[0].args).toEqual({items: [false, 0, null, '']});
  });

  it('places consecutive indexes correctly when they arrive in reverse order', async () => {
    const {calls} = await stream([
      partialCall([
        {jsonPath: '$.items[1]', stringValue: 'beta'},
        {jsonPath: '$.items[0]', stringValue: 'alpha'},
      ]),
    ]);
    expect(calls[0].args).toEqual({items: ['alpha', 'beta']});
  });

  it('keeps a missing-index path in its previous object form', async () => {
    const {calls} = await stream([
      partialCall([{jsonPath: '$.items[1]', stringValue: 'beta'}]),
    ]);
    expect(calls[0].args).toEqual({items: {'1': 'beta'}});
  });

  it('preserves an explicitly supplied null slot in a complete array', async () => {
    const {calls} = await stream([
      partialCall([
        {jsonPath: '$.items[0]', nullValue: 'NULL_VALUE'},
        {jsonPath: '$.items[1]', stringValue: 'beta'},
      ]),
    ]);
    expect(calls[0].args).toEqual({items: [null, 'beta']});
  });

  it('keeps mixed numeric and named members in their previous object form', async () => {
    const {calls} = await stream([
      partialCall([
        {jsonPath: '$.items[0]', stringValue: 'alpha'},
        {jsonPath: "$.items['label']", stringValue: 'description'},
      ]),
    ]);
    expect(calls[0].args).toEqual({
      items: {'0': 'alpha', label: 'description'},
    });
  });

  it.each([0, 'named'])(
    'preserves a length member with value %s',
    async (length) => {
      const {calls} = await stream([
        partialCall([
          {jsonPath: '$.items[0]', stringValue: 'alpha'},
          typeof length === 'number'
            ? {jsonPath: '$.items.length', numberValue: length}
            : {jsonPath: '$.items.length', stringValue: length},
        ]),
      ]);
      expect(calls[0].args).toEqual({items: {'0': 'alpha', length}});
    },
  );

  it('accepts whitespace around an array index', async () => {
    const {calls} = await stream([
      partialCall([{jsonPath: '$.items[ 0 ]', stringValue: 'alpha'}]),
    ]);
    expect(calls[0].args).toEqual({items: ['alpha']});
  });

  it('preserves a quoted member containing a period before an array', async () => {
    const {calls} = await stream([
      partialCall([{jsonPath: "$['a.b'][0].name", stringValue: 'alpha'}]),
    ]);
    expect(calls[0].args).toEqual({'a.b': [{name: 'alpha'}]});
  });

  it('does not confuse an ordinary member with an internal index marker', async () => {
    const {calls} = await stream([
      partialCall([{jsonPath: '$._adkArrayIndex0[0]', stringValue: 'alpha'}]),
    ]);
    expect(calls[0].args).toEqual({_adkArrayIndex0: ['alpha']});
  });

  it('keeps separately streamed calls and IDs independent', async () => {
    const {calls} = await stream([
      partialCall([{jsonPath: '$.items[0]', stringValue: 'alpha'}], 'first'),
      partialCall([{jsonPath: '$.items[0]', stringValue: 'beta'}], 'second'),
    ]);
    expect(calls.map((call) => ({id: call.id, args: call.args}))).toEqual([
      {id: 'first', args: {items: ['alpha']}},
      {id: 'second', args: {items: ['beta']}},
    ]);
  });
});
