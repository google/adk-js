/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `src/google/adk/tests/unittests/tools/openapi_tool/common/test_common.py`
 * at tag `v0.1.0`. Test names are kept verbatim so a reviewer can grep the
 * original; a parametrized case appends its input in brackets so a failure
 * names the case.
 *
 * `TestToSnakeCase` and `TestRenamePythonKeywords` cover functions that live in
 * `core/src/utils/case_utils.ts`, not in the module under test. They stay here
 * so that the ported set matches the reference file one class at a time.
 */

import {
  type ApiParameter,
  createApiParameter,
  generateParamDoc,
  generateReturnDoc,
  getTypeHint,
  renameReservedKeywords,
  toSnakeCaseName,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

/**
 * An OpenAPI document reaches these helpers as decoded text, so a schema can
 * carry a `type` the OpenAPI types do not enumerate, and an array schema can
 * omit `items`. Both states are reachable at run time and neither is
 * expressible as a literal, so the tests decode them the way a document
 * arrives. The reference builds the first one the same way, with
 * `Schema.model_validate_json`.
 */
const UNKNOWN_TYPE_SCHEMA: OpenAPIV3.SchemaObject =
  JSON.parse('{"type":"unknown"}');
const ITEMLESS_ARRAY_SCHEMA: OpenAPIV3.SchemaObject =
  JSON.parse('{"type":"array"}');

describe('TestToSnakeCase', () => {
  it.each([
    ['lowerCamelCase', 'lower_camel_case'],
    ['UpperCamelCase', 'upper_camel_case'],
    ['space separated', 'space_separated'],
    ['REST API', 'rest_api'],
    ['Mixed_CASE with_Spaces', 'mixed_case_with_spaces'],
    ['__init__', 'init'],
    ['APIKey', 'api_key'],
    ['SomeLongURL', 'some_long_url'],
    ['CONSTANT_CASE', 'constant_case'],
    ['already_snake_case', 'already_snake_case'],
    ['single', 'single'],
    ['', ''],
    ['  spaced  ', 'spaced'],
    ['with123numbers', 'with123numbers'],
    ['With_Mixed_123_and_SPACES', 'with_mixed_123_and_spaces'],
    ['HTMLParser', 'html_parser'],
    ['HTTPResponseCode', 'http_response_code'],
    ['a_b_c', 'a_b_c'],
    ['A_B_C', 'a_b_c'],
    ['fromAtoB', 'from_ato_b'],
    ['XMLHTTPRequest', 'xmlhttp_request'],
    ['_leading', 'leading'],
    ['trailing_', 'trailing'],
    ['  leading_and_trailing_  ', 'leading_and_trailing'],
    ['Multiple___Underscores', 'multiple_underscores'],
    ['  spaces_and___underscores  ', 'spaces_and_underscores'],
    ['  _mixed_Case  ', 'mixed_case'],
    ['123Start', '123_start'],
    ['End123', 'end123'],
    ['Mid123dle', 'mid123dle'],
  ])('test_to_snake_case [%s]', (input, expected) => {
    expect(toSnakeCaseName(input)).toBe(expected);
  });
});

describe('TestRenamePythonKeywords', () => {
  it.each([
    // The reference's own cases. These are reserved in BOTH languages, so they
    // cannot tell the two keyword lists apart -- they passed while the wrong
    // list was in place.
    ['in', 'param_in'],
    ['for', 'param_for'],
    ['class', 'param_class'],
    ['normal', 'normal'],
    ['param_if', 'param_if'],
    ['', ''],
  ])('test_rename_python_keywords [%s]', (input, expected) => {
    expect(renameReservedKeywords(input)).toBe(expected);
  });

  // The cases that DO tell them apart. Python's list is the one that matters:
  // this rename exists only to reproduce adk-python's parameter names.
  it.each([
    ['from', 'param_from'],
    ['import', 'param_import'],
    ['def', 'param_def'],
    ['lambda', 'param_lambda'],
    ['not', 'param_not'],
    ['is', 'param_is'],
    ['pass', 'param_pass'],
    ['None', 'param_None'],
  ])('renames the Python-only keyword %s', (input, expected) => {
    expect(renameReservedKeywords(input)).toBe(expected);
  });

  it.each(['function', 'var', 'let', 'typeof', 'new', 'const'])(
    'leaves the JavaScript-only keyword %s alone, as adk-python does',
    (input) => {
      expect(renameReservedKeywords(input)).toBe(input);
    },
  );
});

describe('TestApiParameter', () => {
  it('test_api_parameter_initialization', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'string',
      description: 'A string parameter',
    };
    const param = createApiParameter({
      originalName: 'testParam',
      description: 'A string description',
      paramLocation: 'query',
      paramSchema: schema,
    });

    expect(param.originalName).toBe('testParam');
    expect(param.paramLocation).toBe('query');
    expect(param.paramSchema.type).toBe('string');
    expect(param.paramSchema.description).toBe('A string parameter');
    expect(param.name).toBe('test_param');
    expect(getTypeHint(param.paramSchema)).toBe('str');
    expect(param.description).toBe('A string description');
  });

  it('test_api_parameter_keyword_rename', () => {
    const param = createApiParameter({
      originalName: 'in',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe('param_in');
  });

  it('test_api_parameter_custom_py_name', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
      name: 'custom_name',
    });

    expect(param.name).toBe('custom_name');
  });

  // The reference also asserts a `type_value` column. adk-js does not port
  // `get_type_value`, so only the type hint is checked.
  it.each<[OpenAPIV3.SchemaObject, string]>([
    [{type: 'integer'}, 'int'],
    [{type: 'number'}, 'float'],
    [{type: 'boolean'}, 'bool'],
    [{type: 'string'}, 'str'],
    [{type: 'string', format: 'date'}, 'str'],
    [{type: 'string', format: 'date-time'}, 'str'],
    [{type: 'array', items: {type: 'integer'}}, 'List[int]'],
    [{type: 'array', items: {type: 'string'}}, 'List[str]'],
    [{type: 'array', items: {type: 'object'}}, 'List[Dict[str, Any]]'],
    [{type: 'object'}, 'Dict[str, Any]'],
    [UNKNOWN_TYPE_SCHEMA, 'Any'],
    [{}, 'Any'],
  ])('test_api_parameter_type_hint_helper [%j]', (schema, expectedHint) => {
    const param = createApiParameter({
      originalName: 'test',
      paramLocation: 'query',
      paramSchema: schema,
    });

    expect(getTypeHint(param.paramSchema)).toBe(expectedHint);
  });

  it('test_api_parameter_description', () => {
    const param = createApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'The description',
    });

    expect(param.description).toBe('The description');
  });

  it('test_api_parameter_description_use_schema_fallback', () => {
    const param = createApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'The description'},
    });

    expect(param.description).toBe('The description');
  });
});

describe('TestTypeHintHelper', () => {
  it.each<[OpenAPIV3.SchemaObject, string]>([
    [{type: 'integer'}, 'int'],
    [{type: 'number'}, 'float'],
    [{type: 'string'}, 'str'],
    [{type: 'array', items: {type: 'string'}}, 'List[str]'],
  ])('test_get_type_value_and_hint [%j]', (schema, expectedHint) => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: schema,
      description: 'Test parameter',
    });

    expect(getTypeHint(param.paramSchema)).toBe(expectedHint);
  });
});

describe('TestPydocHelper', () => {
  it('test_generate_param_doc_simple', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
    });

    expect(generateParamDoc(param)).toBe('test_param (str): Test description');
  });

  it('test_generate_param_doc_no_description', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
    });

    expect(generateParamDoc(param)).toBe('test_param (int): ');
  });

  it('test_generate_param_doc_object', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {
        type: 'object',
        properties: {
          prop1: {type: 'string', description: 'Prop1 desc'},
          prop2: {type: 'integer'},
        },
      },
      description: 'Test object parameter',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Dict[str, Any]): Test object parameter Object' +
        ' properties:\n       prop1 (str): Prop1 desc\n       prop2' +
        ' (int): \n',
    );
  });

  it('test_generate_param_doc_object_no_properties', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'object', description: 'A test schema'},
      description: 'The description.',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Dict[str, Any]): The description.',
    );
  });

  it('test_generate_return_doc_simple', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (str): Successful response',
    );
  });

  it('test_generate_return_doc_no_content', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '204': {description: 'No content'},
    };

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('test_generate_return_doc_object', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful object response',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                prop1: {type: 'string', description: 'Prop1 desc'},
                prop2: {type: 'integer'},
              },
            },
          },
        },
      },
    };

    // The reference asserts three substrings. adk-js pins the whole string so
    // that the eight-space return indent cannot drift unnoticed.
    expect(generateReturnDoc(responses)).toBe(
      'Returns (Dict[str, Any]): Successful object response Object' +
        ' properties:\n        prop1 (str): Prop1 desc\n        prop2' +
        ' (int): \n',
    );
  });

  it('test_generate_return_doc_multiple_success', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Bad request'},
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (str): Successful response',
    );
  });

  it('test_generate_return_doc_2xx_smallest_status_code_response', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '201': {
        description: '201 response',
        content: {'application/json': {schema: {type: 'integer'}}},
      },
      '200': {
        description: '200 response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Bad request'},
    };

    expect(generateReturnDoc(responses)).toBe('Returns (str): 200 response');
  });

  it('test_generate_return_doc_contentful_response', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {description: 'No content response'},
      '201': {
        description: '201 response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Bad request'},
    };

    expect(generateReturnDoc(responses)).toBe('Returns (str): 201 response');
  });
});

/**
 * Coverage the reference does not have: the error paths, the `$ref` guards and
 * the response keys `int()` rejects in adk-python.
 */
describe('adk-js behaviour beyond the reference', () => {
  describe('createApiParameter', () => {
    it('defaults description to the empty string', () => {
      const param = createApiParameter({
        originalName: 'anything',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
      });

      expect(param.description).toBe('');
    });

    it('defaults required to false and keeps it when set', () => {
      const optional = createApiParameter({
        originalName: 'q',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
      });
      const mandatory = createApiParameter({
        originalName: 'q',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: true,
      });

      expect(optional.required).toBe(false);
      expect(mandatory.required).toBe(true);
    });
  });

  describe('generateParamDoc', () => {
    it('substitutes an empty description when the parameter has none', () => {
      const param: ApiParameter = {
        originalName: 'petId',
        paramLocation: 'path',
        paramSchema: {type: 'integer'},
        name: 'pet_id',
        required: false,
      };

      expect(generateParamDoc(param)).toBe('pet_id (int): ');
    });

    it('skips a property that is a $ref', () => {
      const param = createApiParameter({
        originalName: 'pet',
        paramLocation: 'body',
        paramSchema: {
          type: 'object',
          properties: {
            linked: {$ref: '#/components/schemas/Pet'},
            name: {type: 'string', description: 'The name'},
          },
        },
        description: 'A pet',
      });

      expect(generateParamDoc(param)).toBe(
        'pet (Dict[str, Any]): A pet Object properties:\n' +
          '       name (str): The name\n',
      );
    });
  });

  describe('getTypeHint', () => {
    it.each<[OpenAPIV3.SchemaObject, string]>([
      [{type: 'array', items: {}}, 'List[Any]'],
      [{type: 'array', items: {type: 'array', items: {}}}, 'List[Any]'],
      [{type: 'array', items: {$ref: '#/components/schemas/Pet'}}, 'List[Any]'],
      [{type: 'array', items: {type: 'boolean'}}, 'List[bool]'],
      [{type: 'array', items: {type: 'number'}}, 'List[float]'],
    ])('maps array items [%j]', (schema, expected) => {
      expect(getTypeHint(schema)).toBe(expected);
    });

    it('reports Any for an array whose items are absent at run time', () => {
      expect(getTypeHint(ITEMLESS_ARRAY_SCHEMA)).toBe('List[Any]');
    });
  });

  describe('generateReturnDoc', () => {
    const stringContent = {
      'application/json': {schema: {type: 'string'} as OpenAPIV3.SchemaObject},
    };

    it('returns an empty string when there are no responses', () => {
      expect(generateReturnDoc({})).toBe('');
    });

    it('ignores a default response, which int() would reject', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        default: {description: 'Unexpected error', content: stringContent},
      };

      expect(generateReturnDoc(responses)).toBe('');
    });

    it('accepts a 2XX wildcard, which int() would reject', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '404': {description: 'Missing'},
        '2XX': {description: 'Wildcard success', content: stringContent},
      };

      expect(generateReturnDoc(responses)).toBe(
        'Returns (str): Wildcard success',
      );
    });

    it('prefers a numeric 2xx response over a wildcard', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '2XX': {description: 'Wildcard success', content: stringContent},
        '200': {description: 'Exact success', content: stringContent},
      };

      expect(generateReturnDoc(responses)).toBe('Returns (str): Exact success');
    });

    it('rejects an empty content map', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {description: 'Declared but empty', content: {}},
      };

      expect(generateReturnDoc(responses)).toBe('');
    });

    it('skips a response that is a $ref', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {$ref: '#/components/responses/Ok'},
        '201': {description: 'Created', content: stringContent},
      };

      expect(generateReturnDoc(responses)).toBe('Returns (str): Created');
    });

    it('reports Any when the response schema is a $ref', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {
          description: 'Referenced schema',
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
          },
        },
      };

      expect(generateReturnDoc(responses)).toBe(
        'Returns (Any): Referenced schema',
      );
    });

    it('reports Any when the media type declares no schema', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {description: 'No schema', content: {'application/json': {}}},
      };

      expect(generateReturnDoc(responses)).toBe('Returns (Any): No schema');
    });

    it('substitutes an empty description when the response has none', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {description: '', content: stringContent},
      };

      expect(generateReturnDoc(responses)).toBe('Returns (str): ');
    });

    it('skips a $ref property of an object response', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {
          description: 'A pet',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  linked: {$ref: '#/components/schemas/Pet'},
                  name: {type: 'string', description: 'The name'},
                },
              },
            },
          },
        },
      };

      expect(generateReturnDoc(responses)).toBe(
        'Returns (Dict[str, Any]): A pet Object properties:\n' +
          '        name (str): The name\n',
      );
    });

    it('omits the property block for an object with no properties', () => {
      const responses: OpenAPIV3.ResponsesObject = {
        '200': {
          description: 'Opaque object',
          content: {'application/json': {schema: {type: 'object'}}},
        },
      };

      expect(generateReturnDoc(responses)).toBe(
        'Returns (Dict[str, Any]): Opaque object',
      );
    });
  });
});
