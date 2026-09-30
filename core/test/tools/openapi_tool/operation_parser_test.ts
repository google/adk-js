/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser, type ApiParameter} from '@google/adk';
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

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema.type).toBe('object');
    expect(returnValue?.paramSchema.properties?.['id']).toBeDefined();
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

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema).toEqual({});
    expect(returnValue?.name).toBe('return');
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

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema.type).toBe('boolean');
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

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema.type).toBe('string');
  });

  it('leaves a JavaScript-only keyword alone, as adk-python does', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name: 'function', in: 'query', schema: {type: 'string'}}],
      responses: {},
    };
    expect(new OperationParser(op).getParameters()[0].name).toBe('function');
  });
  it('should parse a JSON string operation', () => {
    const parser = new OperationParser(
      JSON.stringify({
        operationId: 'stringOp',
        parameters: [{name: 'q', in: 'query', schema: {type: 'integer'}}],
        responses: {},
      }),
    );

    expect(parser.getFunctionName()).toBe('string_op');
    expect(parser.getParameters().length).toBe(1);
    expect(parser.getParameters()[0].originalName).toBe('q');
    expect(parser.getParameters()[0].paramSchema).toEqual({type: 'integer'});
  });
  it('should give the Any type hint for an unrecognised schema type', () => {
    // Only reachable through an untyped input: the OperationObject type
    // permits none of these as a schema `type`.
    const parser = new OperationParser(
      JSON.stringify({
        operationId: 'bogusOp',
        responses: {
          '200': {
            description: 'OK',
            content: {'application/json': {schema: {type: 'bogus'}}},
          },
        },
      }),
    );

    expect(parser.getReturnTypeHint()).toBe('Any');
  });
  it('should skip parsing when shouldParse is false', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'skippedOp',
      parameters: [{name: 'q', in: 'query', schema: {type: 'string'}}],
      responses: {
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };

    const parser = new OperationParser(op, {shouldParse: false});

    expect(parser.getParameters()).toEqual([]);
    expect(parser.getReturnValue()).toBeUndefined();
    expect(parser.getReturnTypeHint()).toBe('Any');
  });
  it('should load a parser without a return value', () => {
    const params: ApiParameter[] = [
      {
        originalName: 'p1',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        name: 'p1',
        required: true,
      },
    ];

    const parser = OperationParser.load({operationId: 'loadedOp'}, params);

    expect(parser.getParameters()).toBe(params);
    expect(parser.getReturnValue()).toBeUndefined();
    expect(parser.getFunctionName()).toBe('loaded_op');
  });
  it('should keep original names when preservePropertyNames is set', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPetById',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {petName: {type: 'string'}},
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op, {preservePropertyNames: true});

    expect(parser.getFunctionName()).toBe('getPetById');
    expect(parser.getParameters()[0].name).toBe('petName');
  });
  it('should omit the returns block when no response qualifies', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'bareOp',
      summary: 'Bare summary',
      responses: {},
    };

    const pydoc = new OperationParser(op).getPydocString();

    expect(pydoc).toContain('Bare summary');
    expect(pydoc).toContain('Args:');
    expect(pydoc).not.toContain('Returns');
  });
  it('should fall back to the description when there is no summary', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'describedOp',
      description: 'Only a description',
      responses: {},
    };

    expect(new OperationParser(op).getPydocString()).toContain(
      'Only a description',
    );
  });
  it('should return an empty auth scheme name for an empty security entry', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'emptySecurityOp',
      security: [{}],
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('');
  });
  it('should skip a non-numeric response key when picking the return doc', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'defaultResponseOp',
      responses: {
        default: {
          description: 'Fallback',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '200': {
          description: 'Numeric success',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
      },
    };

    const pydoc = new OperationParser(op).getPydocString();

    expect(pydoc).toContain('Returns (int): Numeric success');
  });
  it('should handle an operation that declares no responses', () => {
    // A plain object may omit `responses`, which the OperationObject type
    // requires.
    const parser = new OperationParser({operationId: 'noResponsesOp'});

    expect(parser.getReturnTypeHint()).toBe('Any');
    expect(parser.getPydocString()).not.toContain('Returns');
  });
  it('should ignore a request body whose content is empty', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'emptyBodyOp',
      requestBody: {content: {}},
      responses: {},
    };

    expect(new OperationParser(op).getParameters()).toEqual([]);
  });
  it('should list required parameters in the JSON schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'requiredOp',
      parameters: [
        {name: 'needed', in: 'query', required: true, schema: {type: 'string'}},
        {name: 'optional', in: 'query', schema: {type: 'string'}},
      ],
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(schema.required).toEqual(['needed']);
  });
  it('should give List[Any] for an unrecognised array item type', () => {
    // Only reachable through an untyped input, as with the scalar case above.
    const parser = new OperationParser(
      JSON.stringify({
        operationId: 'bogusArrayOp',
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {type: 'array', items: {type: 'bogus'}},
              },
            },
          },
        },
      }),
    );

    expect(parser.getReturnTypeHint()).toBe('List[Any]');
  });
});
