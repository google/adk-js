/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {appendTools, LlmRequest} from '../../src/models/llm_request.js';
import {FunctionTool} from '../../src/tools/function_tool.js';
import {SchemaLike} from '../../src/utils/schema.js';

const arraySchema: Schema = {type: Type.ARRAY, items: {type: Type.STRING}};

function declarations(response: SchemaLike) {
  let executions = 0;
  const tool = new FunctionTool({
    name: 'bounded',
    description: 'Returns items',
    response,
    execute: () => {
      executions++;
      return ['a', 'b'];
    },
  });
  const direct = tool._getDeclaration();
  const request: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
  appendTools(request, [tool]);
  const forwarded = (
    request.config?.tools?.[0] as {functionDeclarations: FunctionDeclaration[]}
  ).functionDeclarations[0];
  expect(request.toolsDict['bounded']).toBe(tool);
  expect(executions).toBe(0);
  return [direct, forwarded];
}

describe.each([
  {
    version: 'Zod 3',
    array: () => z3.array(z3.string()),
    object: () => z3.object({items: z3.array(z3.string()).min(2).max(3)}),
    scalar: () => z3.enum(['a', 'b']),
    union: () => z3.union([z3.array(z3.string()), z3.number()]),
  },
  {
    version: 'Zod 4',
    array: () => z4.array(z4.string()),
    object: () => z4.object({items: z4.array(z4.string()).min(2).max(3)}),
    scalar: () => z4.enum(['a', 'b']),
    union: () => z4.union([z4.array(z4.string()), z4.number()]),
  },
])(
  '$version FunctionTool response declaration',
  ({array, object, scalar, union}) => {
    it('retains root array bounds and description through appendTools', () => {
      const response = array().min(2).max(3).describe('Bounded items');
      for (const declaration of declarations(response)) {
        expect(declaration.response).toEqual({
          ...arraySchema,
          minItems: '2',
          maxItems: '3',
          description: 'Bounded items',
        });
      }
    });

    it('retains only the configured minimum', () => {
      for (const declaration of declarations(array().min(2))) {
        expect(declaration.response).toEqual({...arraySchema, minItems: '2'});
      }
    });

    it('retains only the configured maximum', () => {
      for (const declaration of declarations(array().max(3))) {
        expect(declaration.response).toEqual({...arraySchema, maxItems: '3'});
      }
    });

    it('retains both zero bounds for an empty array', () => {
      for (const declaration of declarations(array().length(0))) {
        expect(declaration.response).toEqual({
          ...arraySchema,
          minItems: '0',
          maxItems: '0',
        });
      }
    });

    it('does not add bounds to an unbounded array', () => {
      for (const declaration of declarations(array())) {
        expect(declaration.response).toEqual(arraySchema);
      }
    });

    it('preserves the object response conversion of nested array bounds', () => {
      for (const declaration of declarations(object())) {
        expect(declaration.response).toEqual({
          type: Type.OBJECT,
          properties: {items: {...arraySchema, minItems: '2', maxItems: '3'}},
          required: ['items'],
        });
      }
    });

    it('preserves a non-array response declaration', () => {
      for (const declaration of declarations(scalar())) {
        expect(declaration.response).toEqual({
          type: Type.STRING,
          enum: ['a', 'b'],
        });
      }
    });

    it('preserves the existing nullable array shape', () => {
      for (const declaration of declarations(array().nullable())) {
        expect(declaration.response).toEqual({...arraySchema, nullable: true});
      }
    });

    it('preserves the existing mixed-union shape', () => {
      for (const declaration of declarations(union())) {
        expect(declaration.response).toEqual({
          anyOf: [arraySchema, {type: Type.NUMBER}],
        });
      }
    });
  },
);

it('keeps a directly supplied genai response Schema unchanged', () => {
  const response: Schema = {
    ...arraySchema,
    minItems: '2',
    maxItems: '3',
    description: 'Direct schema',
  };
  for (const declaration of declarations(response)) {
    expect(declaration.response).toBe(response);
    expect(declaration.response).toEqual({
      ...arraySchema,
      minItems: '2',
      maxItems: '3',
      description: 'Direct schema',
    });
  }
});
