/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  GoogleApiParameter,
  GoogleApiSchema,
  GoogleApiSpec,
  GoogleApiToOpenApiConverter,
  InvocationContext,
  LlmAgent,
  OpenAPIToolset,
  PluginManager,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  convertInfo,
  convertMethods,
  convertOperation,
  convertParameterSchema,
  convertResources,
  convertSchemaObject,
  convertSchemas,
  convertSecuritySchemes,
  convertServers,
  extractPathParameters,
  normalizeGoogleSchemaRef,
} from '../../../src/tools/google_api_tool/googleapi_to_openapi_converter.js';

function createCalendarApiSpec(): GoogleApiSpec {
  return {
    kind: 'discovery#restDescription',
    id: 'calendar:v3',
    name: 'calendar',
    version: 'v3',
    title: 'Google Calendar API',
    description: 'Accesses the Google Calendar API',
    documentationLink: 'https://developers.google.com/calendar/',
    protocol: 'rest',
    rootUrl: 'https://www.googleapis.com/',
    servicePath: 'calendar/v3/',
    auth: {
      oauth2: {
        scopes: {
          'https://www.googleapis.com/auth/calendar': {
            description: 'Full access to Google Calendar',
          },
          'https://www.googleapis.com/auth/calendar.readonly': {
            description: 'Read-only access to Google Calendar',
          },
        },
      },
    },
    schemas: {
      Calendar: {
        type: 'object',
        description: 'A calendar resource',
        properties: {
          id: {
            type: 'string',
            description: 'Calendar identifier',
          },
          summary: {
            type: 'string',
            description: 'Calendar summary',
            required: true,
          },
          timeZone: {
            type: 'string',
            description: 'Calendar timezone',
          },
        },
      },
      Event: {
        type: 'object',
        description: 'An event resource',
        properties: {
          id: {type: 'string', description: 'Event identifier'},
          summary: {type: 'string', description: 'Event summary'},
          start: {$ref: 'EventDateTime'},
          end: {$ref: 'EventDateTime'},
          attendees: {
            type: 'array',
            description: 'Event attendees',
            items: {$ref: 'EventAttendee'},
          },
        },
      },
      EventDateTime: {
        type: 'object',
        description: 'Date/time for an event',
        properties: {
          dateTime: {
            type: 'string',
            format: 'date-time',
            description: 'Date/time in RFC3339 format',
          },
          timeZone: {
            type: 'string',
            description: 'Timezone for the date/time',
          },
        },
      },
      EventAttendee: {
        type: 'object',
        description: 'An attendee of an event',
        properties: {
          email: {type: 'string', description: 'Attendee email'},
          responseStatus: {
            type: 'string',
            description: 'Response status',
            enum: ['needsAction', 'declined', 'tentative', 'accepted'],
          },
        },
      },
    },
    resources: {
      calendars: {
        methods: {
          get: {
            id: 'calendar.calendars.get',
            path: 'calendars/{calendarId}',
            httpMethod: 'GET',
            description: 'Returns metadata for a calendar.',
            parameters: {
              calendarId: {
                type: 'string',
                description: 'Calendar identifier',
                required: true,
                location: 'path',
              },
            },
            response: {$ref: 'Calendar'},
            scopes: [
              'https://www.googleapis.com/auth/calendar',
              'https://www.googleapis.com/auth/calendar.readonly',
            ],
          },
          insert: {
            id: 'calendar.calendars.insert',
            path: 'calendars',
            httpMethod: 'POST',
            description: 'Creates a secondary calendar.',
            request: {$ref: 'Calendar'},
            response: {$ref: 'Calendar'},
            scopes: ['https://www.googleapis.com/auth/calendar'],
          },
        },
        resources: {
          events: {
            methods: {
              list: {
                id: 'calendar.events.list',
                path: 'calendars/{calendarId}/events',
                httpMethod: 'GET',
                description: 'Returns events on the specified calendar.',
                parameters: {
                  calendarId: {
                    type: 'string',
                    description: 'Calendar identifier',
                    required: true,
                    location: 'path',
                  },
                  maxResults: {
                    type: 'integer',
                    description: 'Maximum number of events returned',
                    format: 'int32',
                    minimum: '1',
                    maximum: '2500',
                    default: '250',
                    location: 'query',
                  },
                  orderBy: {
                    type: 'string',
                    description: 'Order of the events returned',
                    enum: ['startTime', 'updated'],
                    location: 'query',
                  },
                },
                response: {$ref: 'Events'},
                scopes: [
                  'https://www.googleapis.com/auth/calendar',
                  'https://www.googleapis.com/auth/calendar.readonly',
                ],
              },
            },
          },
        },
      },
    },
  };
}

function createPreparedConverter(): {
  converter: GoogleApiToOpenApiConverter;
  calendarApiSpec: GoogleApiSpec;
} {
  const calendarApiSpec = createCalendarApiSpec();
  const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
  converter.googleApiSpec = calendarApiSpec;
  return {converter, calendarApiSpec};
}

describe('TestGoogleApiToOpenApiConverter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_init', () => {
    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
    expect(converter.apiName).toBe('calendar');
    expect(converter.apiVersion).toBe('v3');
    expect(converter.googleApiSpec).toBeNull();
    expect(converter.openapiSpec.openapi).toBe('3.0.0');
    expect('info' in converter.openapiSpec).toBe(true);
    expect('paths' in converter.openapiSpec).toBe(true);
    expect('components' in converter.openapiSpec).toBe(true);
  });

  it('test_fetch_google_api_spec', async () => {
    const calendarApiSpec = createCalendarApiSpec();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => calendarApiSpec,
    } as Response);

    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
    await converter.fetchGoogleApiSpec();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
    expect(converter.googleApiSpec).toEqual(calendarApiSpec);
  });

  it('test_fetch_google_api_spec_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
    await expect(converter.fetchGoogleApiSpec()).rejects.toThrow(
      'HTTP Error 404',
    );
  });

  it('test_convert_info', () => {
    const {converter, calendarApiSpec} = createPreparedConverter();
    convertInfo(
      calendarApiSpec,
      converter.openapiSpec,
      converter.apiName,
      converter.apiVersion,
    );

    const info = converter.openapiSpec.info;
    expect(info.title).toBe('Google Calendar API');
    expect(info.description).toBe('Accesses the Google Calendar API');
    expect(info.version).toBe('v3');
    expect(info.termsOfService).toBe('https://developers.google.com/calendar/');

    const externalDocs = converter.openapiSpec.externalDocs;
    expect(externalDocs?.url).toBe('https://developers.google.com/calendar/');
  });

  it('test_convert_servers', () => {
    const {converter, calendarApiSpec} = createPreparedConverter();
    convertServers(
      calendarApiSpec,
      converter.openapiSpec,
      converter.apiName,
      converter.apiVersion,
    );

    const servers = converter.openapiSpec.servers ?? [];
    expect(servers.length).toBe(1);
    expect(servers[0].url).toBe('https://www.googleapis.com/calendar/v3');
    expect(servers[0].description).toBe('calendar v3 API');
  });

  it('test_convert_security_schemes', () => {
    const {converter, calendarApiSpec} = createPreparedConverter();
    convertSecuritySchemes(calendarApiSpec, converter.openapiSpec);

    const securitySchemes =
      converter.openapiSpec.components?.securitySchemes ?? {};

    expect('oauth2' in securitySchemes).toBe(true);
    const oauth2 = securitySchemes['oauth2'] as OpenAPIV3.OAuth2SecurityScheme;
    expect(oauth2.type).toBe('oauth2');

    const scopes = oauth2.flows.authorizationCode?.scopes ?? {};
    expect('https://www.googleapis.com/auth/calendar' in scopes).toBe(true);
    expect('https://www.googleapis.com/auth/calendar.readonly' in scopes).toBe(
      true,
    );

    expect('apiKey' in securitySchemes).toBe(true);
    const apiKey = securitySchemes['apiKey'] as OpenAPIV3.ApiKeySecurityScheme;
    expect(apiKey.type).toBe('apiKey');
    expect(apiKey.in).toBe('query');
    expect(apiKey.name).toBe('key');
  });

  it('test_convert_schemas', () => {
    const {converter, calendarApiSpec} = createPreparedConverter();
    convertSchemas(calendarApiSpec, converter.openapiSpec);

    const schemas = converter.openapiSpec.components?.schemas ?? {};

    expect('Calendar' in schemas).toBe(true);
    const calendarSchema = schemas['Calendar'] as OpenAPIV3.SchemaObject;
    expect(calendarSchema.type).toBe('object');
    expect(calendarSchema.description).toBe('A calendar resource');
    expect(calendarSchema.required).toContain('summary');

    expect('Event' in schemas).toBe(true);
    const eventSchema = schemas['Event'] as OpenAPIV3.SchemaObject;
    const startProp = eventSchema.properties?.[
      'start'
    ] as OpenAPIV3.ReferenceObject;
    expect(startProp.$ref).toBe('#/components/schemas/EventDateTime');

    const attendeesSchema = eventSchema.properties?.[
      'attendees'
    ] as OpenAPIV3.ArraySchemaObject;
    expect(attendeesSchema.type).toBe('array');
    expect((attendeesSchema.items as OpenAPIV3.ReferenceObject).$ref).toBe(
      '#/components/schemas/EventAttendee',
    );

    const attendeeSchema = schemas['EventAttendee'] as OpenAPIV3.SchemaObject;
    const responseStatus = attendeeSchema.properties?.[
      'responseStatus'
    ] as OpenAPIV3.SchemaObject;
    expect(responseStatus.enum).toContain('accepted');
  });

  it('test_convert_schema_object', () => {
    const cases: Array<{
      schemaDef: GoogleApiSchema;
      expectedType: string | undefined;
      expectedAttrs: Record<string, unknown>;
    }> = [
      {
        schemaDef: {
          type: 'object',
          description: 'Test object',
          properties: {
            id: {type: 'string', required: true},
            name: {type: 'string'},
          },
        },
        expectedType: 'object',
        expectedAttrs: {description: 'Test object', required: ['id']},
      },
      {
        schemaDef: {
          type: 'array',
          description: 'Test array',
          items: {type: 'string'},
        },
        expectedType: 'array',
        expectedAttrs: {description: 'Test array', items: {type: 'string'}},
      },
      {
        schemaDef: {$ref: 'Calendar'},
        expectedType: undefined,
        expectedAttrs: {$ref: '#/components/schemas/Calendar'},
      },
      {
        schemaDef: {type: 'string', enum: ['value1', 'value2']},
        expectedType: 'string',
        expectedAttrs: {enum: ['value1', 'value2']},
      },
    ];

    for (const {schemaDef, expectedType, expectedAttrs} of cases) {
      const converted = convertSchemaObject(schemaDef) as Record<
        string,
        unknown
      >;
      if (expectedType) {
        expect(converted['type']).toBe(expectedType);
      }
      for (const [key, value] of Object.entries(expectedAttrs)) {
        expect(converted[key]).toEqual(value);
      }
    }
  });

  it('test_extract_path_parameters', () => {
    const cases: Array<{path: string; expectedParams: string[]}> = [
      {
        path: '/calendars/{calendarId}/events/{eventId}',
        expectedParams: ['calendarId', 'eventId'],
      },
      {
        path: '/calendars/events',
        expectedParams: [],
      },
      {
        path: '/users/{userId}/calendars/default',
        expectedParams: ['userId'],
      },
    ];

    for (const {path: urlPath, expectedParams} of cases) {
      const params = extractPathParameters(urlPath);
      expect(new Set(params)).toEqual(new Set(expectedParams));
      expect(params.length).toBe(expectedParams.length);
    }
  });

  it('test_convert_parameter_schema', () => {
    const cases: Array<{
      paramData: GoogleApiParameter;
      expectedResult: Record<string, unknown>;
    }> = [
      {
        paramData: {
          type: 'string',
          description: 'String parameter',
          pattern: '^[a-z]+$',
        },
        expectedResult: {type: 'string', pattern: '^[a-z]+$'},
      },
      {
        paramData: {type: 'integer', format: 'int32', default: '10'},
        expectedResult: {type: 'integer', format: 'int32', default: '10'},
      },
      {
        paramData: {type: 'string', enum: ['option1', 'option2']},
        expectedResult: {type: 'string', enum: ['option1', 'option2']},
      },
    ];

    for (const {paramData, expectedResult} of cases) {
      const converted = convertParameterSchema(paramData) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(expectedResult)) {
        expect(converted[key]).toEqual(value);
      }
    }
  });

  it('test_convert', async () => {
    const calendarApiSpec = createCalendarApiSpec();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => calendarApiSpec,
    } as Response);

    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
    const result = await converter.convert();

    expect(result.openapi).toBe('3.0.0');
    expect('info' in result).toBe(true);
    expect('servers' in result).toBe(true);
    expect('paths' in result).toBe(true);
    expect('components' in result).toBe(true);

    const paths = result.paths;
    expect('/calendars/{calendarId}' in paths).toBe(true);
    const calendarPath = paths['/calendars/{calendarId}'];
    expect(calendarPath?.get).toBeDefined();

    expect('/calendars/{calendarId}/events' in paths).toBe(true);

    const getCalendar = calendarPath?.get;
    expect(getCalendar?.operationId).toBe('calendar.calendars.get');
    expect(getCalendar?.parameters).toBeDefined();

    const insertCalendar = paths['/calendars']?.post;
    expect(insertCalendar?.requestBody).toBeDefined();
    const requestBody =
      insertCalendar?.requestBody as OpenAPIV3.RequestBodyObject;
    const requestSchema = requestBody.content['application/json']
      .schema as OpenAPIV3.ReferenceObject;
    expect(requestSchema.$ref).toBe('#/components/schemas/Calendar');

    const response200 = getCalendar?.responses?.[
      '200'
    ] as OpenAPIV3.ResponseObject;
    const responseSchema = response200.content?.['application/json']
      ?.schema as OpenAPIV3.ReferenceObject;
    expect(responseSchema.$ref).toBe('#/components/schemas/Calendar');
  });

  it('test_convert_methods', () => {
    const {converter, calendarApiSpec} = createPreparedConverter();
    const methods = calendarApiSpec.resources?.['calendars']?.methods ?? {};
    convertMethods(methods, '/calendars', converter.openapiSpec);

    const paths = converter.openapiSpec.paths;
    expect('/calendars/{calendarId}' in paths).toBe(true);
    const getMethod = paths['/calendars/{calendarId}']?.get;
    expect(getMethod?.operationId).toBe('calendar.calendars.get');

    const params = (getMethod?.parameters ?? []) as OpenAPIV3.ParameterObject[];
    const paramNames = params.map((p) => p.name);
    expect(paramNames).toContain('calendarId');

    expect('/calendars' in paths).toBe(true);
    const postMethod = paths['/calendars']?.post;
    expect(postMethod?.operationId).toBe('calendar.calendars.insert');

    const requestBody = postMethod?.requestBody as OpenAPIV3.RequestBodyObject;
    const requestRef = requestBody.content['application/json']
      .schema as OpenAPIV3.ReferenceObject;
    expect(requestRef.$ref).toBe('#/components/schemas/Calendar');

    const response200 = postMethod?.responses?.[
      '200'
    ] as OpenAPIV3.ResponseObject;
    const responseRef = response200.content?.['application/json']
      ?.schema as OpenAPIV3.ReferenceObject;
    expect(responseRef.$ref).toBe('#/components/schemas/Calendar');
  });

  it('test_convert_resources', () => {
    const {converter, calendarApiSpec} = createPreparedConverter();
    convertResources(calendarApiSpec.resources ?? {}, converter.openapiSpec);

    const paths = converter.openapiSpec.paths;
    expect('/calendars/{calendarId}' in paths).toBe(true);
    expect('/calendars/{calendarId}/events' in paths).toBe(true);

    const eventsMethod = paths['/calendars/{calendarId}/events']?.get;
    expect(eventsMethod?.operationId).toBe('calendar.events.list');

    const params = (eventsMethod?.parameters ??
      []) as OpenAPIV3.ParameterObject[];
    const paramNames = params.map((p) => p.name);
    expect(paramNames).toContain('calendarId');
    expect(paramNames).toContain('maxResults');
    expect(paramNames).toContain('orderBy');
  });

  it('test_integration_calendar_api', async () => {
    const calendarApiSpec = createCalendarApiSpec();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => calendarApiSpec,
    } as Response);

    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
    const openapiSpec = await converter.convert();

    expect(openapiSpec.info.title).toBe('Google Calendar API');
    expect(openapiSpec.servers?.[0].url).toBe(
      'https://www.googleapis.com/calendar/v3',
    );

    const securitySchemes = openapiSpec.components?.securitySchemes ?? {};
    expect('oauth2' in securitySchemes).toBe(true);
    expect('apiKey' in securitySchemes).toBe(true);

    const schemas = openapiSpec.components?.schemas ?? {};
    expect('Calendar' in schemas).toBe(true);
    expect('Event' in schemas).toBe(true);
    expect('EventDateTime' in schemas).toBe(true);

    const paths = openapiSpec.paths;
    expect('/calendars/{calendarId}' in paths).toBe(true);
    expect('/calendars' in paths).toBe(true);
    expect('/calendars/{calendarId}/events' in paths).toBe(true);

    const getEvents = paths['/calendars/{calendarId}/events']?.get;
    expect(getEvents?.operationId).toBe('calendar.events.list');

    const params = (getEvents?.parameters ?? []) as OpenAPIV3.ParameterObject[];
    const paramDict = Object.fromEntries(params.map((p) => [p.name, p]));
    expect('maxResults' in paramDict).toBe(true);
    const maxResults = paramDict['maxResults'];
    expect(maxResults.in).toBe('query');
    const maxResultsSchema = maxResults.schema as OpenAPIV3.SchemaObject;
    expect(maxResultsSchema.type).toBe('integer');
    expect(maxResultsSchema.default).toBe('250');
  });
});

describe('GoogleApiToOpenApiConverter additional branch coverage', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, {recursive: true, force: true});
      tempDir = undefined;
    }
  });

  it('converts any schema type into oneOf and handles hash-prefixed refs', () => {
    const anySchema = convertSchemaObject({
      type: 'any',
      description: 'Arbitrary value',
      default: 'fallback',
      pattern: '.*',
      format: 'custom',
    }) as Record<string, unknown>;

    expect(anySchema['oneOf']).toEqual([
      {type: 'object'},
      {type: 'array'},
      {type: 'string'},
      {type: 'number'},
      {type: 'boolean'},
      {type: 'null'},
    ]);
    expect(anySchema['description']).toBe('Arbitrary value');
    expect(anySchema['default']).toBe('fallback');
    expect(anySchema['pattern']).toBe('.*');
    expect(anySchema['format']).toBe('custom');

    expect(normalizeGoogleSchemaRef('#Event')).toBe(
      '#/components/schemas/Event',
    );
    expect(normalizeGoogleSchemaRef('Event')).toBe(
      '#/components/schemas/Event',
    );
  });

  it('throws when fetched spec is empty and saves converted spec to disk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const emptyConverter = new GoogleApiToOpenApiConverter('calendar', 'v3');
    await expect(emptyConverter.fetchGoogleApiSpec()).rejects.toThrow(
      'Failed to retrieve API specification',
    );

    const {converter} = createPreparedConverter();
    await converter.convert();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-api-spec-'));
    const outFile = path.join(tempDir, 'openapi_spec.json');
    converter.saveOpenapiSpec(outFile);

    const saved = JSON.parse(
      fs.readFileSync(outFile, 'utf-8'),
    ) as OpenAPIV3.Document;
    expect(saved.info.title).toBe('Google Calendar API');
  });

  it('extracts path parameters from custom-verb and {+resource} segments and resolves URLs without literal placeholders', async () => {
    expect(
      extractPathParameters('/v1/documents/{documentId}:batchUpdate'),
    ).toEqual(['documentId']);
    expect(extractPathParameters('/{+resource}:getIamPolicy')).toEqual([
      'resource',
    ]);
    expect(
      extractPathParameters(
        '/v4/spreadsheets/{spreadsheetId}/values/{range}:append',
      ),
    ).toEqual(['spreadsheetId', 'range']);

    const directOp = convertOperation(
      {
        id: 'custom.method',
        parameters: {
          itemId: {type: 'string', location: 'path'},
          traceHeader: {type: 'string', location: 'header', required: false},
        },
      },
      [],
    );
    expect(directOp.parameters).toEqual([
      {
        name: 'itemId',
        in: 'path',
        description: '',
        required: true,
        schema: {type: 'string'},
      },
      {
        name: 'traceHeader',
        in: 'header',
        description: '',
        required: false,
        schema: {type: 'string'},
      },
    ]);

    const converter = new GoogleApiToOpenApiConverter('docs', 'v1');
    converter.googleApiSpec = {
      rootUrl: 'https://docs.googleapis.com/',
      servicePath: '',
      resources: {
        documents: {
          methods: {
            batchUpdate: {
              id: 'docs.documents.batchUpdate',
              path: 'v1/documents/{documentId}:batchUpdate',
              httpMethod: 'POST',
              description: 'Applies updates to the document.',
              parameters: {
                documentId: {
                  type: 'string',
                  required: true,
                  location: 'path',
                },
              },
            },
          },
        },
        tables: {
          methods: {
            getIamPolicy: {
              id: 'bigquery.tables.getIamPolicy',
              path: '{+resource}:getIamPolicy',
              httpMethod: 'POST',
              description: 'Gets the access control policy for a resource.',
              parameters: {
                resource: {
                  type: 'string',
                  required: true,
                  location: 'path',
                },
              },
            },
          },
        },
      },
    };

    const openapiSpec = await converter.convert();
    expect('/v1/documents/{documentId}:batchUpdate' in openapiSpec.paths).toBe(
      true,
    );
    expect('/{resource}:getIamPolicy' in openapiSpec.paths).toBe(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ok: true}),
    } as Response);

    const openapiToolset = new OpenAPIToolset({specDict: openapiSpec});
    const batchUpdateTool = openapiToolset.getTool(
      'docs_documents_batch_update',
    );
    const getIamPolicyTool = openapiToolset.getTool(
      'bigquery_tables_get_iam_policy',
    );
    expect(batchUpdateTool).toBeDefined();
    expect(getIamPolicyTool).toBeDefined();

    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-1', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
    });

    await batchUpdateTool?.runAsync({
      args: {document_id: 'doc-123'},
      toolContext,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://docs.googleapis.com/v1/documents/doc-123:batchUpdate',
      expect.objectContaining({method: 'POST'}),
    );

    await getIamPolicyTool?.runAsync({
      args: {resource: 'projects/p/datasets/d/tables/t'},
      toolContext,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://docs.googleapis.com/projects%2Fp%2Fdatasets%2Fd%2Ftables%2Ft:getIamPolicy',
      expect.objectContaining({method: 'POST'}),
    );
  });
});
