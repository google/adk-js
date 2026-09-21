/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  OpenApiSpecParser,
  OpenAPIToolset,
  ReadonlyContext,
} from '@google/adk';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

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
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'my-key'},
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect((tools[0] as unknown as Record<string, unknown>).authScheme).toEqual(
      {type: 'apiKey', name: 'key', in: 'header'},
    );
    expect(
      (tools[0] as unknown as Record<string, unknown>).authCredential,
    ).toEqual({authType: AuthCredentialTypes.API_KEY, apiKey: 'my-key'});
  });

  it('should return all tools when no toolFilter is set and a context is provided', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    const tools = await toolset.getTools({} as unknown as ReadonlyContext);

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('get_users');
    expect(tools[1].name).toBe('create_user');
  });

  it('should apply a string[] toolFilter when a context is provided', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: ['create_user'],
    });
    const tools = await toolset.getTools({} as unknown as ReadonlyContext);

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('create_user');
  });

  it('should apply a predicate toolFilter when a context is provided', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: (tool) => tool.name === 'get_users',
    });
    const tools = await toolset.getTools({} as unknown as ReadonlyContext);

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('get_users');
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

  it('should return a parsed tool by name from getTool', () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});

    expect(toolset.getTool('get_users')?.name).toBe('get_users');
    expect(toolset.getTool('create_user')?.name).toBe('create_user');
  });

  it('should return undefined from getTool for an unknown name', () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});

    expect(toolset.getTool('no_such_tool')).toBeUndefined();
  });

  it('should look up the prefixed name in getTool when a prefix is set', () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec, prefix: 'test'});

    expect(toolset.getTool('test_get_users')?.name).toBe('test_get_users');
    expect(toolset.getTool('get_users')).toBeUndefined();
  });

  it('should not apply toolFilter in getTool', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: ['get_users'],
    });

    expect((await toolset.getTools()).length).toBe(1);
    expect(toolset.getTool('create_user')?.name).toBe('create_user');
  });

  it('should log one line naming each parsed tool', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    new OpenAPIToolset({specDict: mockSpec});

    expect(infoSpy.mock.calls).toEqual([
      ['Parsed tool: get_users'],
      ['Parsed tool: create_user'],
    ]);
    infoSpy.mockRestore();
  });

  it('should auto-detect YAML from a spec string with no specType', async () => {
    const toolset = new OpenAPIToolset({
      specStr: `---\n${yaml.dump(mockSpec)}`,
    });
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'get_users',
      'create_user',
    ]);
  });

  it('should accept a supported specType on the spec string path', async () => {
    const toolset = new OpenAPIToolset({
      specStr: JSON.stringify(mockSpec),
      specType: 'json',
    });

    expect((await toolset.getTools()).length).toBe(2);
  });
});

describe('OpenAPIToolset spec type', () => {
  const minimalSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {title: 'Test', version: '1.0'},
    paths: {},
  };

  it('should throw naming the unsupported spec type', () => {
    expect(() => {
      // The compiler rejects 'xml' outright, so the only caller that reaches
      // this branch is untyped JavaScript or configuration read at run time.
      // The cast is how a typed test stands in for that caller.
      new OpenAPIToolset({specStr: '{}', specType: 'xml' as 'json'});
    }).toThrow('Unsupported spec type: xml');
  });

  it('should accept json and yaml', () => {
    expect(() => {
      new OpenAPIToolset({
        specStr: JSON.stringify(minimalSpec),
        specType: 'json',
      });
    }).not.toThrow();
    expect(() => {
      new OpenAPIToolset({specStr: yaml.dump(minimalSpec), specType: 'yaml'});
    }).not.toThrow();
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
    expect(operations[0].operation.operationId).toBe('test_get');
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
    const response = operations[0].operation.responses?.['200'] as
      | OpenAPIV3.ResponseObject
      | undefined;
    const schema = response?.content?.['application/json']
      ?.schema as OpenAPIV3.SchemaObject;
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
    const response = operations[0].operation.responses?.['200'] as
      | OpenAPIV3.ResponseObject
      | undefined;
    const schema = response?.content?.['application/json']
      ?.schema as OpenAPIV3.SchemaObject;
    const multiPropSchema = schema.properties?.[
      'multiProp'
    ] as OpenAPIV3.SchemaObject;
    expect(multiPropSchema.type).toEqual(['string', 'integer']);
  });
});
