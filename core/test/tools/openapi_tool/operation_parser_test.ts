/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

describe('OperationParser', () => {
  it('should throw error if operationId is missing', () => {
    const op: OpenAPIV3.OperationObject = {
      responses: {},
    };
    const parser = new OperationParser(op);
    expect(() => parser.getFunctionName()).toThrow('Operation ID is missing');
  });

  it('should parse array request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {type: 'string'},
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('array');
  });

  it('should parse primitive request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'string',
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('string');
  });

  it('should parse response schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: {type: 'integer'},
                },
              },
            },
          },
        },
      },
    };

    const parser = new OperationParser(op);
    const schema = parser.getJsonSchema();

    expect(schema).toBeTruthy();
    expect(schema.title).toBe('testOp_Arguments');
  });

  it('should emit an empty required array when no argument is required', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listItems',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: {type: 'integer'},
        },
      ],
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(schema.required).toEqual([]);
    expect(Array.isArray(schema.required)).toBe(true);
    expect(schema.properties).toHaveProperty('limit');
  });

  it('should list required argument names when some are required', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getUser',
      parameters: [
        {name: 'userId', in: 'path', required: true, schema: {type: 'string'}},
        {
          name: 'verbose',
          in: 'query',
          required: false,
          schema: {type: 'boolean'},
        },
      ],
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(schema.required).toEqual(['user_id']);
    expect(schema.properties).toHaveProperty('verbose');
  });

  it('should emit an empty required array for an operation with no parameters', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'ping',
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(schema.required).toEqual([]);
    expect(schema.properties).toEqual({});
  });

  it('should serialize the required array', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listItems',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: {type: 'integer'},
        },
      ],
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(JSON.parse(JSON.stringify(schema))).toHaveProperty('required', []);
  });
});
