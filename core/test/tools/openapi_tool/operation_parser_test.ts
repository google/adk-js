/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {parseReturnValue} from '../../../src/tools/openapi_tool/openapi_spec_parser/operation_parser.js';

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

  it('should parse a request body whose media type omits the schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        description: 'Arbitrary JSON payload.',
        content: {'application/json': {}},
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].originalName).toBe('body');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema).toEqual({});
    expect(params[0].description).toBe('Arbitrary JSON payload.');
  });

  it('should advertise the body argument for a schema-less request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        description: 'Arbitrary JSON payload.',
        content: {'application/json': {}},
      },
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(parser.getJsonSchema().properties).toHaveProperty('body');
  });

  it('should parse no parameter for a request body with empty content', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        description: 'Arbitrary JSON payload.',
        content: {},
      },
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(parser.getParameters()).toEqual([]);
  });

  it('should use the first 2xx media type that declares a schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'text/plain': {},
            'application/json': {
              schema: {type: 'object', properties: {id: {type: 'integer'}}},
            },
          },
        },
      },
    };

    const returnValue = parseReturnValue(op);

    expect(returnValue.paramSchema.type).toBe('object');
    expect(returnValue.paramSchema.properties?.['id']).toBeDefined();
  });

  it('should keep an empty return schema when no media type declares a schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {'text/plain': {}, 'application/xml': {}},
        },
      },
    };

    const returnValue = parseReturnValue(op);

    expect(returnValue.paramSchema).toEqual({});
    expect(returnValue.name).toBe('return');
  });

  it('should scan the media types of the lowest 2xx response only', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '200': {
          description: 'OK',
          content: {
            'text/plain': {},
            'application/json': {schema: {type: 'boolean'}},
          },
        },
      },
    };

    const returnValue = parseReturnValue(op);

    expect(returnValue.paramSchema.type).toBe('boolean');
  });

  it('should skip a media type whose schema is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
            'application/xml': {schema: {type: 'string'}},
          },
        },
      },
    };

    const returnValue = parseReturnValue(op);

    expect(returnValue.paramSchema.type).toBe('string');
  });
});
