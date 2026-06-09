/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenApiSpecParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

describe('OpenApiSpecParser', () => {
  it('should resolve internal references', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Test API', version: '1.0.0'},
      paths: {
        '/test': {
          post: {
            operationId: 'testOp',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/User',
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              name: {type: 'string'},
            },
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.operation.requestBody).toBeDefined();
    const body = op.operation.requestBody as OpenAPIV3.RequestBodyObject;
    const schema = body.content['application/json']
      .schema as OpenAPIV3.SchemaObject;
    expect(schema.type).toBe('object');
    expect(schema.properties?.name).toBeDefined();
  });

  it('should handle circular references and break the cycle', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Circular API', version: '1.0.0'},
      paths: {
        '/node': {
          get: {
            operationId: 'getNode',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/Node',
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              value: {type: 'string'},
              next: {
                $ref: '#/components/schemas/Node',
              },
            },
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.operation.responses['200']).toBeDefined();
  });

  it('should throw error for external references', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'External API', version: '1.0.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      $ref: 'https://example.com/schemas/User.json',
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    expect(() => parser.parse(spec)).toThrow(
      'External references not supported',
    );
  });

  it('should sanitize schema types', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Sanitize API', version: '1.0.0'},
      paths: {
        '/sanitize': {
          post: {
            operationId: 'sanitizeOp',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'OBJECT', // uppercase, should be normalized
                    properties: {
                      age: {type: 'INTEGER'}, // uppercase, should be normalized
                      invalid: {type: 'unknown_type'}, // invalid, should be removed
                    },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    const body = op.operation.requestBody as OpenAPIV3.RequestBodyObject;
    const schema = body.content['application/json']
      .schema as OpenAPIV3.SchemaObject;
    expect(schema.type).toBe('object');
    expect(schema.properties?.age?.type).toBe('integer');
    expect(
      (schema.properties?.invalid as OpenAPIV3.SchemaObject).type,
    ).toBeUndefined();
  });

  it('should merge path-level parameters and generate operationId if missing', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Param API', version: '1.0.0'},
      paths: {
        '/users/{id}': {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: {type: 'string'},
            },
          ],
          get: {
            // operationId is missing, should be auto-generated as "get__users__id_"
            responses: {},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.name).toBe('get__users__id_');
    expect(op.parameters.length).toBe(1);
    expect(op.parameters[0].name).toBe('id');
  });

  it('should resolve security schemes', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Security API', version: '1.0.0'},
      security: [{ApiKeyAuth: []}], // Global security
      paths: {
        '/secure': {
          get: {
            operationId: 'secureOp',
            responses: {},
          },
          post: {
            operationId: 'securePostOp',
            security: [{OAuth2Auth: []}], // Override security
            responses: {},
          },
        },
      },
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-KEY',
          },
          OAuth2Auth: {
            type: 'oauth2',
            flows: {},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(2);

    // GET secureOp should use global ApiKeyAuth
    const getOp = parsed.find((o) => o.name === 'secure_op');
    expect(getOp).toBeDefined();
    expect(getOp?.authScheme?.type).toBe('apiKey');

    // POST securePostOp should use OAuth2Auth override
    const postOp = parsed.find((o) => o.name === 'secure_post_op');
    expect(postOp).toBeDefined();
    expect(postOp?.authScheme?.type).toBe('oauth2');
  });
});
