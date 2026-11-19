/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python at ref `v0.1.0`:
 * `tests/unittests/tools/openapi_tool/openapi_spec_parser/test_operation_parser.py`.
 *
 * Three of the 25 reference tests are not portable and are listed in the pull
 * request body.
 *
 * The reference file sits in a nested directory; every adk-js openapi test
 * sits flat in `core/test/tools/openapi_tool/`, so this follows the target's
 * layout.
 */

import {ApiParameter, OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

const sampleOperation: OpenAPIV3.OperationObject = {
  operationId: 'test_operation',
  summary: 'Test Summary',
  description: 'Test Description',
  parameters: [
    {
      name: 'param1',
      in: 'query',
      schema: {type: 'string'},
      description: 'Parameter 1',
    },
    {
      name: 'param2',
      in: 'header',
      schema: {type: 'string'},
      description: 'Parameter 2',
    },
  ],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            prop1: {type: 'string', description: 'Property 1'},
            prop2: {type: 'integer', description: 'Property 2'},
          },
        },
      },
    },
    description: 'Request body description',
  },
  responses: {
    '200': {
      description: 'Success',
      content: {'application/json': {schema: {type: 'string'}}},
    },
    '400': {description: 'Client Error'},
  },
  security: [{oauth2: ['resource: read', 'resource: write']}],
};

describe('OperationParser parity with adk-python v0.1.0', () => {
  // test_operation_parser_initialization
  it('parses operation parameters, requestBody properties, and return value on construction', () => {
    const parser = new OperationParser(sampleOperation);

    // The reference asserts `parser.operation == sample_operation`. The field
    // is private in adk-js and stays private, so the parse result is asserted
    // instead.
    expect(parser.getParameters().length).toBe(4); // 2 params + 2 body props
    expect(parser.getReturnValue()).toBeDefined();
  });

  // test_process_operation_parameters
  it('parses query and header operation parameters', () => {
    // The reference calls the private `_process_operation_parameters` after
    // constructing with `should_parse=False`. adk-js keeps the method private,
    // so an operation holding only `parameters` drives the same code path.
    const operation: OpenAPIV3.OperationObject = {
      parameters: sampleOperation.parameters,
      responses: {},
    };
    const parser = new OperationParser(operation);
    const params = parser.getParameters();

    expect(params.length).toBe(2);
    expect(params[0].originalName).toBe('param1');
    expect(params[0].paramLocation).toBe('query');
    expect(params[1].originalName).toBe('param2');
    expect(params[1].paramLocation).toBe('header');
  });

  // test_process_request_body
  it('expands object requestBody properties into body parameters', () => {
    // Ported through the constructor with a requestBody-only operation; the
    // reference calls the private `_process_request_body` directly.
    const operation: OpenAPIV3.OperationObject = {
      requestBody: sampleOperation.requestBody,
      responses: {},
    };
    const parser = new OperationParser(operation);
    const params = parser.getParameters();

    expect(params.length).toBe(2); // 2 properties in request body
    expect(params[0].originalName).toBe('prop1');
    expect(params[0].paramLocation).toBe('body');
    expect(params[1].originalName).toBe('prop2');
    expect(params[1].paramLocation).toBe('body');
  });

  // test_process_request_body_array
  it('parses an array requestBody schema into a single body parameter', () => {
    const operation: OpenAPIV3.OperationObject = {
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  item_prop1: {type: 'string', description: 'Item Property 1'},
                  item_prop2: {type: 'integer', description: 'Item Property 2'},
                },
              },
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(operation);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].originalName).toBe('array');
    expect(params[0].paramLocation).toBe('body');

    // The reference walks into the schema field by field. One structural
    // assertion pins the same nesting and the item descriptions with it.
    expect(params[0].paramSchema).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item_prop1: {type: 'string', description: 'Item Property 1'},
          item_prop2: {type: 'integer', description: 'Item Property 2'},
        },
      },
    });
  });

  // test_process_request_body_no_name
  it('parses a primitive requestBody schema with an empty originalName', () => {
    const operation: OpenAPIV3.OperationObject = {
      requestBody: {
        content: {'application/json': {schema: {type: 'string'}}},
      },
      responses: {},
    };
    const parser = new OperationParser(operation);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].originalName).toBe('');
    expect(params[0].paramLocation).toBe('body');
  });

  // test_dedupe_param_names
  it('deduplicates identically named parameters across locations', () => {
    // The reference assigns three duplicate params and calls the private
    // `_dedupe_param_names`. Three identically named query parameters drive
    // the same code path through the constructor.
    const operation: OpenAPIV3.OperationObject = {
      parameters: [
        {name: 'test', in: 'query', schema: {type: 'string'}},
        {name: 'test', in: 'header', schema: {type: 'string'}},
        {name: 'test', in: 'cookie', schema: {type: 'string'}},
      ],
      responses: {},
    };
    const parser = new OperationParser(operation);
    const params = parser.getParameters();

    // Deliberate divergence: the adk-js suffix starts at 1, the reference's at
    // 0. Renumbering shipped behaviour over a cosmetic difference is not worth
    // the break.
    expect(params[0].name).toBe('test');
    expect(params[1].name).toBe('test_1');
    expect(params[2].name).toBe('test_2');
  });

  // test_process_return_value
  it('parses the 200 response into the return value', () => {
    const parser = new OperationParser(sampleOperation);

    expect(parser.getReturnValue()).toBeDefined();
    expect(parser.getReturnTypeHint()).toBe('str');
  });

  // test_process_return_value_no_2xx
  it('defaults return type hint to Any when no 2xx response exists', () => {
    const operation: OpenAPIV3.OperationObject = {
      responses: {'400': {description: 'Client Error'}},
    };
    const parser = new OperationParser(operation);

    expect(parser.getReturnValue()).toBeDefined();
    expect(parser.getReturnTypeHint()).toBe('Any');
  });

  // test_process_return_value_multiple_2xx
  it('selects the smallest 2xx status code when multiple 2xx responses exist', () => {
    const operation: OpenAPIV3.OperationObject = {
      responses: {
        '201': {
          description: 'Success',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '202': {
          description: 'Success',
          content: {'text/plain': {schema: {type: 'string'}}},
        },
        '200': {
          description: 'Success',
          content: {'application/pdf': {schema: {type: 'boolean'}}},
        },
        '400': {
          description: 'Failure',
          content: {'application/xml': {schema: {type: 'object'}}},
        },
      },
    };
    const parser = new OperationParser(operation);

    const returnValue = parser.getReturnValue();
    expect(returnValue).toBeDefined();
    // The 200 response wins because it is the smallest 2xx code.
    expect(returnValue!.paramSchema.type).toBe('boolean');
  });

  // test_process_return_value_no_content
  it('defaults return type hint to Any when 2xx response has empty content', () => {
    const operation: OpenAPIV3.OperationObject = {
      responses: {'200': {description: 'Success', content: {}}},
    };
    const parser = new OperationParser(operation);

    expect(parser.getReturnTypeHint()).toBe('Any');
  });

  // test_process_return_value_no_schema
  it('defaults return type hint to Any when 2xx media type omits schema', () => {
    const operation: OpenAPIV3.OperationObject = {
      responses: {
        '200': {description: 'Success', content: {'application/json': {}}},
      },
    };
    const parser = new OperationParser(operation);

    expect(parser.getReturnTypeHint()).toBe('Any');
  });

  // test_get_function_name
  it('returns the snake-cased operationId from getFunctionName', () => {
    const parser = new OperationParser(sampleOperation);

    expect(parser.getFunctionName()).toBe('test_operation');
  });

  // test_get_function_name_missing_id
  it('throws when operationId is missing', () => {
    const parser = new OperationParser({responses: {}});

    expect(() => parser.getFunctionName()).toThrow('Operation ID is missing');
  });

  // test_get_return_type_hint
  it('returns the Python type hint for the return value', () => {
    const parser = new OperationParser(sampleOperation);

    expect(parser.getReturnTypeHint()).toBe('str');
  });

  // test_get_parameters
  it('returns all parsed ApiParameter objects', () => {
    const parser = new OperationParser(sampleOperation);
    const params = parser.getParameters();

    expect(params.length).toBe(4);
    // `isinstance(p, ApiParameter)` becomes a structural check: adk-js's
    // `ApiParameter` is an erased interface, not a class.
    for (const param of params) {
      expect(typeof param.originalName).toBe('string');
      expect(typeof param.paramLocation).toBe('string');
      expect(typeof param.name).toBe('string');
      expect(param.paramSchema).toBeDefined();
    }
  });

  // test_get_return_value
  it('returns the parsed return value ApiParameter', () => {
    const parser = new OperationParser(sampleOperation);
    const returnValue = parser.getReturnValue();

    expect(returnValue).toBeDefined();
    expect(typeof returnValue!.originalName).toBe('string');
    expect(typeof returnValue!.paramLocation).toBe('string');
    expect(returnValue!.paramSchema).toBeDefined();
  });

  // test_get_auth_scheme_name
  it('returns the first security scheme name', () => {
    const parser = new OperationParser(sampleOperation);

    expect(parser.getAuthSchemeName()).toBe('oauth2');
  });

  // test_get_auth_scheme_name_no_security
  it('returns an empty string when no security scheme is configured', () => {
    const parser = new OperationParser({responses: {}});

    expect(parser.getAuthSchemeName()).toBe('');
  });

  // test_get_pydoc_string
  it('generates a Python-style docstring from summary, parameters, and return value', () => {
    const parser = new OperationParser(sampleOperation);
    const pydocString = parser.getPydocString();

    expect(pydocString).toContain('Test Summary');
    expect(pydocString).toContain('Args:');
    expect(pydocString).toContain('param1 (str): Parameter 1');
    expect(pydocString).toContain('prop1 (str): Property 1');
    expect(pydocString).toContain('Returns (str):');
    expect(pydocString).toContain('Success');
  });

  // test_get_json_schema
  it('generates a JSON schema for the operation arguments', () => {
    const parser = new OperationParser(sampleOperation);
    const jsonSchema = parser.getJsonSchema();

    expect(jsonSchema.title).toBe('test_operation_Arguments');
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toHaveProperty('param1');
    expect(jsonSchema.properties).toHaveProperty('prop1');
    // Deliberate divergence: adk-js derives `required` from the spec's own
    // required flags, and the fixture sets none. The reference marks every
    // parameter required, which would send the model wrong constraints.
    // "Nothing is required" is stated as an empty array rather than by
    // omitting the key, so the declaration's shape does not vary with content.
    expect(jsonSchema.required).toEqual([]);
  });

  // test_load
  it('constructs an OperationParser from pre-parsed parameters and return value', () => {
    const operation: OpenAPIV3.OperationObject = {
      operationId: 'my_op',
      responses: {},
    };
    const params: ApiParameter[] = [
      {
        originalName: 'p1',
        paramLocation: '',
        paramSchema: {type: 'integer'},
        name: 'p1',
        required: false,
      },
    ];
    const returnValue: ApiParameter = {
      originalName: '',
      paramLocation: '',
      paramSchema: {type: 'string'},
      name: 'return',
      required: true,
    };

    const parser = OperationParser.load(operation, params, returnValue);

    expect(parser).toBeInstanceOf(OperationParser);
    expect(parser.getParameters()).toBe(params);
    expect(parser.getReturnValue()).toBe(returnValue);
    expect(parser.getFunctionName()).toBe('my_op');
  });

  // test_operation_parser_with_dict
  it('parses a plain object operation definition', () => {
    const operationDict: Record<string, unknown> = {
      operationId: 'test_dict_operation',
      parameters: [{name: 'dict_param', in: 'query', schema: {type: 'string'}}],
      responses: {
        '200': {
          description: 'Dict Success',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };
    const parser = new OperationParser(operationDict);

    // `parser.operation.operationId` is unassertable: the field is private.
    expect(parser.getFunctionName()).toBe('test_dict_operation');
    expect(parser.getParameters().length).toBe(1);
    expect(parser.getParameters()[0].originalName).toBe('dict_param');
    expect(parser.getReturnTypeHint()).toBe('str');
  });
});

describe('OperationParser requestBody empty object', () => {
  // test_process_request_body_empty_object
  it('produces no parameters for an empty object requestBody by default', () => {
    const operation: OpenAPIV3.OperationObject = {
      requestBody: {
        content: {
          'application/json': {
            schema: {type: 'object'},
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(operation);
    const params = parser.getParameters();

    expect(params).toHaveLength(0);
  });

  // test_process_request_body_empty_object_with_unconstrained_compat_option
  it('exposes an unconstrained object requestBody as a body parameter when compat option is set', () => {
    const operation: OpenAPIV3.OperationObject = {
      requestBody: {
        content: {
          'application/json': {
            schema: {type: 'object'},
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(operation, {
      unconstrainedObjectBodyAsParameter: true,
    });
    const params = parser.getParameters();

    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      name: 'body',
      originalName: '',
      paramLocation: 'body',
      paramSchema: {type: 'object'},
      required: true,
    });
  });
});
