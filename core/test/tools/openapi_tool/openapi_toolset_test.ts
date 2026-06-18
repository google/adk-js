/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenApiSpecParser, OpenAPIToolset, ReadonlyContext} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

describe('OpenAPIToolset', () => {
  const mockSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {
      title: 'Test API',
      version: '1.0.0',
    },
    servers: [{url: 'https://api.example.com'}],
    paths: {
      '/users': {
        get: {
          operationId: 'getUsers',
          summary: 'Get users',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Limit the number of users',
              schema: {type: 'integer'},
            },
          ],
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: {type: 'string'},
                        name: {type: 'string'},
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createUser',
          summary: 'Create user',
          requestBody: {
            description: 'User to create',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {type: 'string'},
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created',
            },
          },
        },
      },
    },
  };

  it('should parse OpenAPI spec and create tools', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('get_users');
    expect(tools[1].name).toBe('create_user');
  });

  it('should filter tools', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: ['get_users'],
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('get_users');
  });

  it('should apply prefix', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      prefix: 'test',
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('test_get_users');
    expect(tools[1].name).toBe('test_create_user');
  });

  it('should apply global auth overrides', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      authScheme: {type: 'apiKey', name: 'key', in: 'header'},
      authCredential: {api_key: 'my-key'},
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect((tools[0] as unknown as Record<string, unknown>).authScheme).toEqual(
      {type: 'apiKey', name: 'key', in: 'header'},
    );
    expect(
      (tools[0] as unknown as Record<string, unknown>).authCredential,
    ).toEqual({api_key: 'my-key'});
  });

  it('should handle context in getTools', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    const mockContext = {};
    (
      toolset as unknown as {
        isToolSelected: (tool: unknown, context: unknown) => boolean;
      }
    ).isToolSelected = () => true;
    const tools = await toolset.getTools(
      mockContext as unknown as ReadonlyContext,
    );
    expect(tools.length).toBe(2);
  });

  it('should call close', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});

describe('OpenApiSpecParser', () => {
  const mockSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {title: 'Test', version: '1.0'},
    paths: {
      '/test': {
        get: {
          operationId: 'testOp',
          responses: {'200': {description: 'OK'}},
        },
      },
    },
  };

  it('should parse operations', () => {
    const parser = new OpenApiSpecParser();
    const operations = parser.parse(mockSpec);

    expect(operations.length).toBe(1);
    expect(operations[0].name).toBe('test_op');
  });

  it('should resolve references', () => {
    const specWithRef = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [{$ref: '#/components/parameters/limit'}],
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        parameters: {
          limit: {
            name: 'limit',
            in: 'query',
            schema: {type: 'integer'},
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithRef);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.parameters?.[0]).toEqual({
      name: 'limit',
      in: 'query',
      schema: {type: 'integer'},
    });
  });

  it('should generate operationId if missing', () => {
    const specMissingId = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            responses: {'200': {description: 'OK'}},
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specMissingId);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.operationId).toBe('get__test');
  });

  it('should extract specific security scheme', () => {
    const specWithSecurity = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            security: [{custom_auth: []}],
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        securitySchemes: {
          custom_auth: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithSecurity);

    expect(operations.length).toBe(1);
    expect(operations[0].authScheme).toEqual({
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });
  });

  it('should handle broken reference', () => {
    const specWithBrokenRef = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [{$ref: '#/components/parameters/nonexistent'}],
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        parameters: {},
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithBrokenRef);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.parameters?.[0]).toEqual({
      $ref: '#/components/parameters/nonexistent',
    });
  });

  it('should handle global security', () => {
    const specWithGlobalSecurity = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      security: [{global_auth: []}],
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        securitySchemes: {
          global_auth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithGlobalSecurity);

    expect(operations.length).toBe(1);
    expect(operations[0].authScheme).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('should sanitize invalid schema types', () => {
    const specWithInvalidType = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        invalidProp: {type: 'Any'},
                        validProp: {type: 'string'},
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithInvalidType);

    expect(operations.length).toBe(1);
    const schema = operations[0].operation.responses?.['200']?.content?.[
      'application/json'
    ]?.schema as OpenAPIV3.SchemaObject;
    const invalidPropSchema = schema.properties?.[
      'invalidProp'
    ] as OpenAPIV3.SchemaObject;
    const validPropSchema = schema.properties?.[
      'validProp'
    ] as OpenAPIV3.SchemaObject;
    expect(invalidPropSchema.type).toBeUndefined();
    expect(validPropSchema.type).toBe('string');
  });

  it('should sanitize invalid schema types in array', () => {
    const specWithInvalidArrayType = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        multiProp: {type: ['string', 'Any', 'integer']},
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithInvalidArrayType);

    expect(operations.length).toBe(1);
    const schema = operations[0].operation.responses?.['200']?.content?.[
      'application/json'
    ]?.schema as OpenAPIV3.SchemaObject;
    const multiPropSchema = schema.properties?.[
      'multiProp'
    ] as OpenAPIV3.SchemaObject;
    expect(multiPropSchema.type).toEqual(['string', 'integer']);
  });
});
