/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports of the adk-python reference tests for `OpenApiSpecParser`.
 *
 * Source: `tests/unittests/tools/openapi_tool/openapi_spec_parser/
 * test_openapi_spec_parser.py` at adk-python tag `v0.1.0`. The `it()` strings
 * keep the Python test names so the two files can be compared by name.
 */

import {OpenApiSpecParser, ParsedOperation} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

/** Creates a minimal valid OpenAPI spec. */
function createMinimalOpenApiSpec(): OpenAPIV3.Document {
  return {
    openapi: '3.1.0',
    info: {title: 'Minimal API', version: '1.0.0'},
    paths: {
      '/test': {
        get: {
          summary: 'Test GET endpoint',
          operationId: 'testGet',
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {schema: {type: 'string'}},
              },
            },
          },
        },
      },
    },
  };
}

/** Returns the schema of a parsed operation's return value. */
function returnSchema(op: ParsedOperation): OpenAPIV3.SchemaObject {
  if (!op.returnValue) {
    expect.fail(`operation '${op.name}' has no return value`);
  }
  return op.returnValue.paramSchema;
}

/** Walks a chain of `properties` names and returns the schema it reaches. */
function propertySchema(
  schema: OpenAPIV3.SchemaObject,
  ...names: string[]
): OpenAPIV3.SchemaObject {
  let current = schema;
  for (const name of names) {
    const next = current.properties?.[name];
    if (!next || '$ref' in next) {
      expect.fail(`expected a resolved schema at property '${name}'`);
    }
    current = next;
  }
  return current;
}

describe('OpenApiSpecParser parity with adk-python v0.1.0', () => {
  it('test_parse_minimal_spec', () => {
    const openapiSpec = createMinimalOpenApiSpec();

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const op = parsedOperations[0];

    expect(parsedOperations.length).toBe(1);
    expect(op.name).toBe('test_get');
    expect(op.endpoint.path).toBe('/test');
    expect(op.endpoint.method).toBe('get');
    // Python asserts `return_value.type_value == str`. `type_value` is a
    // Python type object built by common.py's TypeHintHelper, which adk-js's
    // ApiParameter does not carry, so this asserts the schema type instead.
    expect(returnSchema(op).type).toBe('string');
  });

  it('test_parse_spec_with_no_operation_id', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    delete openapiSpec.paths['/test']!.get!.operationId;

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(1);
    expect(parsedOperations[0].name).toBe('test_get');
  });

  it('test_parse_spec_with_multiple_methods', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.paths['/test']!.post = {
      summary: 'Test POST endpoint',
      operationId: 'testPost',
      responses: {'200': {description: 'Successful response'}},
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const operationNames = new Set(parsedOperations.map((op) => op.name));

    expect(parsedOperations.length).toBe(2);
    expect(operationNames.has('test_get')).toBe(true);
    expect(operationNames.has('test_post')).toBe(true);
  });

  it('test_parse_spec_with_parameters', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.paths['/test']!.get!.parameters = [
      {name: 'param1', in: 'query', schema: {type: 'string'}},
      {name: 'param2', in: 'header', schema: {type: 'integer'}},
    ];

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const parameters = parsedOperations[0].parameters;

    expect(parameters.length).toBe(2);
    expect(parameters[0].originalName).toBe('param1');
    expect(parameters[0].paramLocation).toBe('query');
    expect(parameters[1].originalName).toBe('param2');
    expect(parameters[1].paramLocation).toBe('header');
  });

  it('test_parse_spec_with_request_body', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.paths['/test']!.post = {
      summary: 'Endpoint with request body',
      operationId: 'testPostWithBody',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {name: {type: 'string'}},
            },
          },
        },
      },
      responses: {'200': {description: 'OK'}},
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const postOperations = parsedOperations.filter(
      (op) => op.endpoint.method === 'post',
    );
    const op = postOperations[0];

    expect(postOperations.length).toBe(1);
    expect(op.name).toBe('test_post_with_body');
    expect(op.parameters.length).toBe(1);
    expect(op.parameters[0].originalName).toBe('name');
    // Python asserts `type_value == str`; see test_parse_minimal_spec.
    expect(op.parameters[0].paramSchema.type).toBe('string');
  });

  it('test_parse_spec_with_reference', () => {
    const openapiSpec: OpenAPIV3.Document = {
      openapi: '3.1.0',
      info: {title: 'API with Refs', version: '1.0.0'},
      paths: {
        '/test_ref': {
          get: {
            summary: 'Endpoint with ref',
            operationId: 'testGetRef',
            responses: {
              '200': {
                description: 'Success',
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/MySchema'},
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          MySchema: {
            type: 'object',
            properties: {name: {type: 'string'}},
          },
        },
      },
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const op = parsedOperations[0];

    expect(parsedOperations.length).toBe(1);
    // Python asserts `return_value.type_value.__origin__ is dict`. adk-js
    // keeps the resolved schema, so this asserts the schema it resolved to.
    expect(returnSchema(op).type).toBe('object');
    expect(propertySchema(returnSchema(op), 'name').type).toBe('string');
  });

  it('test_parse_spec_with_circular_reference', () => {
    const openapiSpec: OpenAPIV3.Document = {
      openapi: '3.1.0',
      info: {title: 'Circular Ref API', version: '1.0.0'},
      paths: {
        '/circular': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/A'},
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: {
            type: 'object',
            properties: {b: {$ref: '#/components/schemas/B'}},
          },
          B: {
            type: 'object',
            properties: {a: {$ref: '#/components/schemas/A'}},
          },
        },
      },
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    expect(parsedOperations.length).toBe(1);

    const op = parsedOperations[0];
    // Python asserts `type_hint == "Dict[str, Any]"`, a Python type-hint
    // string adk-js has no equivalent for. This asserts the property the
    // hint stood for: the resolver broke the cycle and dropped the $ref.
    expect(returnSchema(op).type).toBe('object');
    const cycleEnd = propertySchema(returnSchema(op), 'b', 'a');
    expect(cycleEnd).toEqual({});
  });

  it('test_parse_no_paths', () => {
    const openapiSpec = {
      openapi: '3.1.0',
      info: {title: 'No Paths API', version: '1.0.0'},
    } as OpenAPIV3.Document;

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(0);
  });

  it('test_parse_empty_path_item', () => {
    const openapiSpec: OpenAPIV3.Document = {
      openapi: '3.1.0',
      info: {title: 'Empty Path Item API', version: '1.0.0'},
      paths: {'/empty': undefined},
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(0);
  });

  it('test_parse_spec_with_global_auth_scheme', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.security = [{api_key: []}];
    openapiSpec.components = {
      securitySchemes: {
        api_key: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
      },
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const op = parsedOperations[0];

    expect(parsedOperations.length).toBe(1);
    expect(op.authScheme).toBeDefined();
    expect(op.authScheme?.type).toBe('apiKey');
  });

  it('test_parse_spec_with_local_auth_scheme', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.paths['/test']!.get!.security = [{local_auth: []}];
    openapiSpec.components = {
      securitySchemes: {local_auth: {type: 'http', scheme: 'bearer'}},
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    const authScheme = parsedOperations[0].authScheme;

    if (authScheme?.type !== 'http') {
      expect.fail('expected an http security scheme');
    }
    expect(authScheme.scheme).toBe('bearer');
  });

  it('test_parse_spec_with_servers', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.servers = [
      {url: 'https://api.example.com'},
      {url: 'http://localhost:8000'},
    ];

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(1);
    expect(parsedOperations[0].endpoint.baseUrl).toBe(
      'https://api.example.com',
    );
  });

  it('test_parse_spec_with_no_servers', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    delete openapiSpec.servers;

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(1);
    expect(parsedOperations[0].endpoint.baseUrl).toBe('');
  });

  it('test_parse_spec_with_description', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    const expectedDescription = 'This is a test description.';
    openapiSpec.paths['/test']!.get!.description = expectedDescription;

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(1);
    expect(parsedOperations[0].description).toBe(expectedDescription);
  });

  it('test_parse_spec_with_empty_description', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    openapiSpec.paths['/test']!.get!.description = '';
    openapiSpec.paths['/test']!.get!.summary = '';

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(1);
    expect(parsedOperations[0].description).toBe('');
  });

  it('test_parse_spec_with_no_description', () => {
    const openapiSpec = createMinimalOpenApiSpec();
    delete openapiSpec.paths['/test']!.get!.description;
    delete openapiSpec.paths['/test']!.get!.summary;

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);

    expect(parsedOperations.length).toBe(1);
    expect(parsedOperations[0].description).toBe('');
  });

  it('test_parse_invalid_openapi_spec_type', () => {
    // Divergence. Python raises AttributeError for each of these. TypeScript
    // rejects them at compile time, so they only reach the parser through a
    // cast, and the parser finds no paths and returns an empty list.
    const parser = new OpenApiSpecParser();
    const parseUnknown = (spec: unknown) =>
      parser.parse(spec as OpenAPIV3.Document);

    expect(parseUnknown(123)).toEqual([]);
    expect(parseUnknown('openapi_spec')).toEqual([]);
    expect(parseUnknown([])).toEqual([]);
  });

  it('test_parse_external_ref_raises_error', () => {
    const openapiSpec: OpenAPIV3.Document = {
      openapi: '3.1.0',
      info: {title: 'External Ref API', version: '1.0.0'},
      paths: {
        '/external': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      $ref: 'external_file.json#/components/schemas/ExternalSchema',
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(() => new OpenApiSpecParser().parse(openapiSpec)).toThrow(
      'External references not supported: external_file.json#/components/schemas/ExternalSchema',
    );
  });

  it('test_parse_spec_with_multiple_paths_deep_refs', () => {
    const openapiSpec: OpenAPIV3.Document = {
      openapi: '3.1.0',
      info: {title: 'Multiple Paths Deep Refs API', version: '1.0.0'},
      paths: {
        '/path1': {
          post: {
            operationId: 'postPath1',
            requestBody: {
              content: {
                'application/json': {
                  schema: {$ref: '#/components/schemas/Request1'},
                },
              },
            },
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/Response1'},
                  },
                },
              },
            },
          },
        },
        '/path2': {
          put: {
            operationId: 'putPath2',
            requestBody: {
              content: {
                'application/json': {
                  schema: {$ref: '#/components/schemas/Request2'},
                },
              },
            },
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/Response2'},
                  },
                },
              },
            },
          },
          get: {
            operationId: 'getPath2',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/Response2'},
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Request1: {
            type: 'object',
            properties: {req1_prop1: {$ref: '#/components/schemas/Level1_1'}},
          },
          Response1: {
            type: 'object',
            properties: {res1_prop1: {$ref: '#/components/schemas/Level1_2'}},
          },
          Request2: {
            type: 'object',
            properties: {req2_prop1: {$ref: '#/components/schemas/Level1_1'}},
          },
          Response2: {
            type: 'object',
            properties: {res2_prop1: {$ref: '#/components/schemas/Level1_2'}},
          },
          Level1_1: {
            type: 'object',
            properties: {
              level1_1_prop1: {$ref: '#/components/schemas/Level2_1'},
            },
          },
          Level1_2: {
            type: 'object',
            properties: {
              level1_2_prop1: {$ref: '#/components/schemas/Level2_2'},
            },
          },
          Level2_1: {
            type: 'object',
            properties: {level2_1_prop1: {$ref: '#/components/schemas/Level3'}},
          },
          Level2_2: {
            type: 'object',
            properties: {level2_2_prop1: {type: 'string'}},
          },
          Level3: {type: 'integer'},
        },
      },
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    expect(parsedOperations.length).toBe(3);

    const path1Ops = parsedOperations.filter(
      (op) => op.endpoint.path === '/path1',
    );
    expect(path1Ops.length).toBe(1);
    const path1Op = path1Ops[0];
    expect(path1Op.name).toBe('post_path1');

    expect(path1Op.parameters.length).toBe(1);
    expect(path1Op.parameters[0].originalName).toBe('req1_prop1');
    expect(
      propertySchema(
        path1Op.parameters[0].paramSchema,
        'level1_1_prop1',
        'level2_1_prop1',
      ).type,
    ).toBe('integer');
    expect(
      propertySchema(
        returnSchema(path1Op),
        'res1_prop1',
        'level1_2_prop1',
        'level2_2_prop1',
      ).type,
    ).toBe('string');

    const path2Op = parsedOperations.filter(
      (op) => op.endpoint.path === '/path2' && op.name === 'put_path2',
    )[0];
    expect(path2Op).toBeDefined();
    expect(path2Op.parameters.length).toBe(1);
    expect(path2Op.parameters[0].originalName).toBe('req2_prop1');
    expect(
      propertySchema(
        path2Op.parameters[0].paramSchema,
        'level1_1_prop1',
        'level2_1_prop1',
      ).type,
    ).toBe('integer');
    expect(
      propertySchema(
        returnSchema(path2Op),
        'res2_prop1',
        'level1_2_prop1',
        'level2_2_prop1',
      ).type,
    ).toBe('string');
  });

  it('test_parse_spec_with_duplicate_parameter_names', () => {
    const openapiSpec: OpenAPIV3.Document = {
      openapi: '3.1.0',
      info: {title: 'Duplicate Parameter Names API', version: '1.0.0'},
      paths: {
        '/duplicate': {
          post: {
            operationId: 'createWithDuplicate',
            parameters: [{name: 'name', in: 'query', schema: {type: 'string'}}],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {name: {type: 'integer'}},
                  },
                },
              },
            },
            responses: {'200': {description: 'OK'}},
          },
        },
      },
    };

    const parsedOperations = new OpenApiSpecParser().parse(openapiSpec);
    expect(parsedOperations.length).toBe(1);
    const op = parsedOperations[0];
    expect(op.name).toBe('create_with_duplicate');
    expect(op.parameters.length).toBe(2);

    const queryParam = op.parameters.find(
      (param) =>
        param.paramLocation === 'query' && param.originalName === 'name',
    );
    const bodyParam = op.parameters.find(
      (param) =>
        param.paramLocation === 'body' && param.originalName === 'name',
    );

    expect(queryParam?.name).toBe('name');
    // Divergence. adk-python's _dedupe_param_names suffixes the second
    // duplicate `name_0`; adk-js's dedupeParamNames suffixes it `name_1`.
    // That difference belongs to operation_parser and is pinned, not changed.
    expect(bodyParam?.name).toBe('name_1');
  });
});
