/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * `tests/unittests/tools/openapi_tool/openapi_spec_parser/test_rest_api_tool.py`
 * at tag `v0.1.0`. Each `it(...)` keeps the Python test name verbatim so a
 * reviewer can grep the original.
 */

import {
  ApiParameter,
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createRestApiToolFromJson,
  createSession,
  InvocationContext,
  LlmAgent,
  OperationEndpoint,
  PluginManager,
  RestApiTool,
  ToolAuthHandler,
} from '@google/adk';
import {Type} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createApiKeyScheme} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';
import {
  prepareRequestBody,
  prepareRequestParams,
} from '../../../src/tools/openapi_tool/rest_api_tool.js';
// `openApiSchemaToGeminiSchema` is internal, like `toGeminiSchema`, so the test
// imports it the way `core/test/utils/gemini_schema_util_test.ts` does.
import {openApiSchemaToGeminiSchema} from '../../../src/utils/gemini_schema_util.js';

const sampleEndpoint: OperationEndpoint = {
  baseUrl: 'https://example.com',
  path: '/test',
  method: 'GET',
};

const sampleOperation: OpenAPIV3.OperationObject = {
  operationId: 'testOperation',
  description: 'Test operation',
  parameters: [],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {testBodyParam: {type: 'string'}},
        },
      },
    },
  },
  responses: {},
};

const sampleApiParameters: ApiParameter[] = [
  {
    originalName: 'test_param',
    name: 'test_param',
    paramLocation: 'query',
    paramSchema: {type: 'string'},
    required: true,
  },
  {
    originalName: '',
    name: 'test_body_param',
    paramLocation: 'body',
    paramSchema: {type: 'string'},
    required: true,
  },
];

const sampleReturnParameter: ApiParameter = {
  originalName: 'test_param',
  name: 'test_param',
  paramLocation: 'query',
  paramSchema: {type: 'string'},
  required: true,
};

const sampleAuthScheme = createApiKeyScheme('X-Api-Key', 'header');

const sampleAuthCredential: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'sample_auth_credential_internal_test',
};

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('RestApiTool parity with adk-python v0.1.0', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The reference asserts `tool.endpoint`, `tool.operation`, `tool.auth_scheme`
  // and `tool.auth_credential`, which adk-js keeps private, and
  // `tool.credential_exchanger`, which adk-js owns inside `ToolAuthHandler`.
  // Those assertions are dropped; the rest is the observable surface.
  it('test_init', () => {
    const tool = new RestApiTool(
      'test_tool',
      'Test Tool',
      sampleEndpoint,
      sampleOperation,
      sampleAuthScheme,
      sampleAuthCredential,
    );

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('Test Tool');
    expect(tool._getDeclaration()).toMatchObject({
      name: 'test_tool',
      description: 'Test Tool',
    });
  });

  it('test_from_parsed_operation_str', () => {
    // The reference derives the name from the operation and ignores the `name`
    // field, so the field is omitted here to assert the derivation.
    const parsedOperationJson = JSON.stringify({
      description: 'Test Description',
      endpoint: sampleEndpoint,
      operation: sampleOperation,
      authScheme: null,
      authCredential: null,
      parameters: sampleApiParameters,
      returnValue: sampleReturnParameter,
    });

    const tool = createRestApiToolFromJson(parsedOperationJson);

    expect(tool.name).toBe('test_operation');
  });

  // The reference injects a mock parser through `should_parse_operation=False`.
  // `operationParser` stays private in adk-js, so the tool is built from a real
  // parameterless operation instead.
  it('test_get_declaration', () => {
    const tool = new RestApiTool(
      'test_tool',
      'Test description',
      sampleEndpoint,
      {operationId: 'test_op', responses: {}},
    );

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe('test_tool');
    expect(declaration.description).toBe('Test description');
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
  });

  it('test_call_success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'application/json'},
      // A real Response exposes both; the tool reads text() and parses, so a
      // malformed body can fall back without the body being already consumed.
      text: async () => JSON.stringify({result: 'success'}),
      json: async () => ({result: 'success'}),
    });
    const tool = new RestApiTool(
      'test_tool',
      'Test Tool',
      sampleEndpoint,
      sampleOperation,
      sampleAuthScheme,
      sampleAuthCredential,
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({result: 'success'});
  });

  it('test_call_auth_pending', async () => {
    const tool = new RestApiTool(
      'test_tool',
      'Test Tool',
      sampleEndpoint,
      sampleOperation,
      sampleAuthScheme,
      sampleAuthCredential,
    );
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue({
      prepareAuthCredentials: async () => ({state: 'pending' as const}),
    } as ToolAuthHandler);

    const response = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(response).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
  });

  it('test_prepare_request_params_query_body', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'param1',
        name: 'param1',
        paramLocation: 'body',
        paramSchema: {type: 'string'},
        required: false,
      },
      {
        originalName: 'param2',
        name: 'param2',
        paramLocation: 'body',
        paramSchema: {type: 'integer'},
        required: false,
      },
      {
        originalName: 'testQueryParam',
        name: 'test_query_param',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              param1: {type: 'string'},
              param2: {type: 'integer'},
            },
          },
        },
      },
    };

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      param1: 'value1',
      param2: 123,
      test_query_param: 'query_value',
    });
    const body = prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(params.url).toBe(
      'https://example.com/test?testQueryParam=query_value',
    );
    expect(body).toBe(JSON.stringify({param1: 'value1', param2: 123}));
  });

  it('test_prepare_request_params_array', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'array',
        name: 'array',
        paramLocation: 'body',
        paramSchema: {type: 'array', items: {type: 'string'}},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {
        'application/json': {
          schema: {type: 'array', items: {type: 'string'}},
        },
      },
    };

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      array: ['item1', 'item2'],
    });
    const body = prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(body).toBe(JSON.stringify(['item1', 'item2']));
  });

  it('test_prepare_request_params_string', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: '',
        name: 'input_string',
        paramLocation: 'body',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {'text/plain': {schema: {type: 'string'}}},
    };

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      input_string: 'test_value',
    });
    const body = prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(body).toBe('test_value');
    expect(params.headers['Content-Type']).toBe('text/plain');
  });

  // D2: adk-js returns `URLSearchParams` and lets `fetch` set the header, which
  // adds the charset the reference's literal header omits.
  it('test_prepare_request_params_form_data', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'key1',
        name: 'key1',
        paramLocation: 'body',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {
        'application/x-www-form-urlencoded': {
          schema: {type: 'object', properties: {key1: {type: 'string'}}},
        },
      },
    };

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      key1: 'value1',
    });
    const body = prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('key1')).toBe('value1');
    expect(params.headers['Content-Type']).toBeUndefined();
  });

  // D1: adk-js returns `FormData` and lets `fetch` set the header, because a
  // literal `multipart/form-data` header omits the MIME boundary.
  it('test_prepare_request_params_multipart', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'file1',
        name: 'file1',
        paramLocation: 'body',
        paramSchema: {type: 'string', format: 'binary'},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {file1: {type: 'string', format: 'binary'}},
          },
        },
      },
    };

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      file1: 'file_content',
    });
    const body = prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file1')).toBe('file_content');
    expect(params.headers['Content-Type']).toBeUndefined();
  });

  it('test_prepare_request_params_octet_stream', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: '',
        name: 'data',
        paramLocation: 'body',
        paramSchema: {type: 'string', format: 'binary'},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {
        'application/octet-stream': {
          schema: {type: 'string', format: 'binary'},
        },
      },
    };
    const binaryData = new Uint8Array([98, 105, 110]);

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      data: binaryData,
    });
    const body = prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(body).toBe(binaryData);
    expect(params.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('test_prepare_request_params_path_param', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'user_id',
        name: 'user_id',
        paramLocation: 'path',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];
    const endpointWithPath: OperationEndpoint = {
      baseUrl: 'https://example.com',
      path: '/test/{user_id}',
      method: 'get',
    };

    const params = prepareRequestParams(endpointWithPath, parameters, {
      user_id: '123',
    });

    expect(params.url).toBe('https://example.com/test/123');
  });

  it('test_prepare_request_params_header_param', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'X-Custom-Header',
        name: 'x_custom_header',
        paramLocation: 'header',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      x_custom_header: 'header_value',
    });

    expect(params.headers['X-Custom-Header']).toBe('header_value');
  });

  it('test_prepare_request_params_cookie_param', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'session_id',
        name: 'session_id',
        paramLocation: 'cookie',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      session_id: 'cookie_value',
    });

    expect(params.cookies['session_id']).toBe('cookie_value');
  });

  it('test_prepare_request_params_multiple_mime_types', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: '',
        name: 'input',
        paramLocation: 'body',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];
    const requestBody: OpenAPIV3.RequestBodyObject = {
      content: {
        'application/json': {schema: {type: 'string'}},
        'text/plain': {schema: {type: 'string'}},
      },
    };

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      input: 'some_value',
    });
    prepareRequestBody(
      requestBody,
      params.body,
      params.bodyData,
      params.headers,
    );

    expect(params.headers['Content-Type']).toBe('application/json');
  });

  it('test_prepare_request_params_unknown_parameter', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'known_param',
        name: 'known_param',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      known_param: 'value',
      unknown_param: 'unknown',
    });

    expect(params.url).toBe('https://example.com/test?known_param=value');
  });

  it('test_prepare_request_params_base_url_handling', () => {
    const paramsNoBase = prepareRequestParams(
      {baseUrl: '', path: '/no_base', method: 'get'},
      [],
      {},
    );
    expect(paramsNoBase.url).toBe('/no_base');

    const paramsTrailing = prepareRequestParams(
      {baseUrl: 'https://example.com/', path: '/trailing', method: 'get'},
      [],
      {},
    );
    expect(paramsTrailing.url).toBe('https://example.com/trailing');
  });

  it('test_prepare_request_params_no_unrecognized_query_parameter', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'unrecognized_param',
        name: 'unrecognized_param',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      unrecognized_param: null,
    });

    expect(params.url).toBe('https://example.com/test');
  });

  it('test_prepare_request_params_no_credential', () => {
    const parameters: ApiParameter[] = [
      {
        originalName: 'param_name',
        name: 'param_name',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: false,
      },
      {
        originalName: 'empty_param',
        name: 'empty_param',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];

    const params = prepareRequestParams(sampleEndpoint, parameters, {
      param_name: 'aaa',
      empty_param: '',
    });

    expect(params.url).toBe('https://example.com/test?param_name=aaa');
  });
});

describe('openApiSchemaToGeminiSchema parity with adk-python v0.1.0', () => {
  it('test_to_gemini_schema_none', () => {
    expect(openApiSchemaToGeminiSchema(null)).toBeUndefined();
  });

  it('test_to_gemini_schema_not_dict', () => {
    expect(() => openApiSchemaToGeminiSchema('not a dict')).toThrow(
      'openapi_schema must be a dictionary',
    );
    expect(() => openApiSchemaToGeminiSchema('not a dict')).toThrow(TypeError);
  });

  it('test_to_gemini_schema_empty_dict', () => {
    const result = openApiSchemaToGeminiSchema({});

    expect(result?.type).toBe(Type.OBJECT);
    expect(result?.properties).toEqual({
      dummy_DO_NOT_GENERATE: {type: Type.STRING},
    });
  });

  it('test_to_gemini_schema_dict_with_only_object_type', () => {
    const result = openApiSchemaToGeminiSchema({type: 'object'});

    expect(result?.type).toBe(Type.OBJECT);
    expect(result?.properties).toEqual({
      dummy_DO_NOT_GENERATE: {type: Type.STRING},
    });
  });

  it('test_to_gemini_schema_basic_types', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {
        name: {type: 'string'},
        age: {type: 'integer'},
        is_active: {type: 'boolean'},
      },
    });

    expect(geminiSchema?.type).toBe(Type.OBJECT);
    expect(geminiSchema?.properties?.['name'].type).toBe(Type.STRING);
    expect(geminiSchema?.properties?.['age'].type).toBe(Type.INTEGER);
    expect(geminiSchema?.properties?.['is_active'].type).toBe(Type.BOOLEAN);
  });

  it('test_to_gemini_schema_nested_objects', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: {type: 'string'},
            city: {type: 'string'},
          },
        },
      },
    });
    const address = geminiSchema?.properties?.['address'];

    expect(address?.type).toBe(Type.OBJECT);
    expect(address?.properties?.['street'].type).toBe(Type.STRING);
    expect(address?.properties?.['city'].type).toBe(Type.STRING);
  });

  it('test_to_gemini_schema_array', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'array',
      items: {type: 'string'},
    });

    expect(geminiSchema?.type).toBe(Type.ARRAY);
    expect(geminiSchema?.items?.type).toBe(Type.STRING);
  });

  it('test_to_gemini_schema_nested_array', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'array',
      items: {
        type: 'object',
        properties: {name: {type: 'string'}},
      },
    });

    expect(geminiSchema?.items?.properties?.['name'].type).toBe(Type.STRING);
  });

  it('test_to_gemini_schema_any_of', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      anyOf: [{type: 'string'}, {type: 'integer'}],
    });

    expect(geminiSchema?.anyOf).toHaveLength(2);
    expect(geminiSchema?.anyOf?.[0].type).toBe(Type.STRING);
    expect(geminiSchema?.anyOf?.[1].type).toBe(Type.INTEGER);
  });

  it('test_to_gemini_schema_general_list', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'array',
      properties: {
        list_field: {type: 'array', items: {type: 'string'}},
      },
    });
    const listField = geminiSchema?.properties?.['list_field'];

    expect(listField?.type).toBe(Type.ARRAY);
    expect(listField?.items?.type).toBe(Type.STRING);
  });

  it('test_to_gemini_schema_enum', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'string',
      enum: ['a', 'b', 'c'],
    });

    expect(geminiSchema?.enum).toEqual(['a', 'b', 'c']);
  });

  it('test_to_gemini_schema_required', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'object',
      required: ['name'],
      properties: {name: {type: 'string'}},
    });

    expect(geminiSchema?.required).toEqual(['name']);
  });

  it('test_to_gemini_schema_nested_dict', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {metadata: {key1: 'value1', key2: 123}},
    });
    const metadata = geminiSchema?.properties?.['metadata'];

    // `metadata` is neither a properties map nor an items schema, so it is
    // converted recursively and gains the default object type.
    expect(metadata?.type).toBe(Type.OBJECT);
    expect(metadata?.properties).toEqual({
      dummy_DO_NOT_GENERATE: {type: Type.STRING},
    });
  });

  it('test_to_gemini_schema_ignore_title_default_format', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'string',
      title: 'Test Title',
      default: 'default_value',
      format: 'date',
    });

    expect(geminiSchema?.title).toBeUndefined();
    expect(geminiSchema?.default).toBeUndefined();
    expect(geminiSchema?.format).toBeUndefined();
  });

  it('test_to_gemini_schema_property_ordering', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'object',
      propertyOrdering: ['name', 'age'],
      properties: {
        name: {type: 'string'},
        age: {type: 'integer'},
      },
    });

    expect(geminiSchema?.propertyOrdering).toEqual(['name', 'age']);
  });

  it('test_to_gemini_schema_converts_property_dict', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      properties: {
        name: {type: 'string', description: 'The property key'},
        value: {type: 'string', description: 'The property value'},
      },
      type: 'object',
      description: 'A single property entry in the Properties message.',
    });

    expect(geminiSchema?.type).toBe(Type.OBJECT);
    expect(geminiSchema?.properties?.['name'].type).toBe(Type.STRING);
    expect(geminiSchema?.properties?.['value'].type).toBe(Type.STRING);
  });

  it('test_to_gemini_schema_remove_unrecognized_fields', () => {
    const geminiSchema = openApiSchemaToGeminiSchema({
      type: 'string',
      description: 'A single date string.',
      format: 'date',
    });

    expect(geminiSchema?.type).toBe(Type.STRING);
    expect(geminiSchema?.format).toBeUndefined();
  });
});
