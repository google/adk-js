/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';

const GOOGLE_DISCOVERY_BASE_URL =
  'https://www.googleapis.com/discovery/v1/apis';
const GOOGLE_OAUTH2_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_OAUTH2_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Scope metadata in a Google API Discovery document.
 */
export interface GoogleApiOAuth2Scope {
  description?: string;
}

/**
 * Parameter metadata in a Google API Discovery document.
 */
export interface GoogleApiParameter {
  type?: string;
  description?: string;
  required?: boolean;
  location?: string;
  format?: string;
  enum?: string[];
  default?: unknown;
  pattern?: string;
  minimum?: string;
  maximum?: string;
}

/**
 * Schema definition in a Google API Discovery document.
 */
export interface GoogleApiSchema {
  type?: string;
  description?: string;
  format?: string;
  enum?: string[];
  pattern?: string;
  default?: unknown;
  required?: boolean;
  $ref?: string;
  properties?: Record<string, GoogleApiSchema>;
  items?: GoogleApiSchema;
  minimum?: string;
  maximum?: string;
  location?: string;
}

/**
 * Method definition in a Google API Discovery document.
 */
export interface GoogleApiMethod {
  id?: string;
  path?: string;
  httpMethod?: string;
  description?: string;
  parameters?: Record<string, GoogleApiParameter>;
  request?: {$ref?: string};
  response?: {$ref?: string};
  scopes?: string[];
}

/**
 * Resource definition in a Google API Discovery document.
 */
export interface GoogleApiResource {
  methods?: Record<string, GoogleApiMethod>;
  resources?: Record<string, GoogleApiResource>;
}

/**
 * Root structure of a Google API Discovery REST specification.
 */
export interface GoogleApiSpec {
  kind?: string;
  id?: string;
  name?: string;
  version?: string;
  title?: string;
  description?: string;
  documentationLink?: string;
  protocol?: string;
  rootUrl?: string;
  servicePath?: string;
  auth?: {
    oauth2?: {
      scopes?: Record<string, GoogleApiOAuth2Scope>;
    };
  };
  schemas?: Record<string, GoogleApiSchema>;
  resources?: Record<string, GoogleApiResource>;
  methods?: Record<string, GoogleApiMethod>;
}

/**
 * Converts a Google Discovery schema reference (`#Name` or `Name`) to an
 * OpenAPI v3 component schema reference (`#/components/schemas/Name`).
 */
export function normalizeGoogleSchemaRef(ref: string): string {
  if (ref.startsWith('#')) {
    return `#/components/schemas/${ref.slice(1)}`;
  }
  return `#/components/schemas/${ref}`;
}

/**
 * Populates the OpenAPI `info` and optional `externalDocs` sections from a
 * Google API Discovery document.
 */
export function convertInfo(
  googleApiSpec: GoogleApiSpec,
  openapiSpec: OpenAPIV3.Document,
  apiName: string,
  apiVersion: string,
): void {
  openapiSpec.info = {
    title: googleApiSpec.title ?? `${apiName} API`,
    description: googleApiSpec.description ?? '',
    version: googleApiSpec.version ?? apiVersion,
    contact: {},
    termsOfService: googleApiSpec.documentationLink ?? '',
  };

  const docsLink = googleApiSpec.documentationLink;
  if (docsLink) {
    openapiSpec.externalDocs = {
      description: 'API Documentation',
      url: docsLink,
    };
  }
}

/**
 * Populates the OpenAPI `servers` list from the Google Discovery `rootUrl` and
 * `servicePath`.
 */
export function convertServers(
  googleApiSpec: GoogleApiSpec,
  openapiSpec: OpenAPIV3.Document,
  apiName: string,
  apiVersion: string,
): void {
  let baseUrl = `${googleApiSpec.rootUrl ?? ''}${googleApiSpec.servicePath ?? ''}`;
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }

  openapiSpec.servers = [
    {
      url: baseUrl,
      description: `${apiName} ${apiVersion} API`,
    },
  ];
}

/**
 * Populates `components.securitySchemes` and top-level `security` from a
 * Google API Discovery document.
 */
export function convertSecuritySchemes(
  googleApiSpec: GoogleApiSpec,
  openapiSpec: OpenAPIV3.Document,
): void {
  openapiSpec.components = openapiSpec.components ?? {};
  openapiSpec.components.securitySchemes =
    openapiSpec.components.securitySchemes ?? {};

  const oauth2 = googleApiSpec.auth?.oauth2;
  const hasOauth2 = oauth2 !== undefined && Object.keys(oauth2).length > 0;
  const formattedScopes: Record<string, string> = {};

  if (hasOauth2) {
    const scopes = oauth2.scopes ?? {};
    for (const [scope, scopeInfo] of Object.entries(scopes)) {
      formattedScopes[scope] = scopeInfo.description ?? '';
    }

    openapiSpec.components.securitySchemes['oauth2'] = {
      type: 'oauth2',
      description: 'OAuth 2.0 authentication',
      flows: {
        authorizationCode: {
          authorizationUrl: GOOGLE_OAUTH2_AUTH_URL,
          tokenUrl: GOOGLE_OAUTH2_TOKEN_URL,
          scopes: formattedScopes,
        },
      },
    };
  }

  openapiSpec.components.securitySchemes['apiKey'] = {
    type: 'apiKey',
    in: 'query',
    name: 'key',
    description: 'API key for accessing this API',
  };

  openapiSpec.security = [
    hasOauth2 ? {oauth2: Object.keys(formattedScopes)} : {},
    {apiKey: []},
  ];
}

/**
 * Recursively converts a Google API Discovery schema object to an OpenAPI v3
 * schema or reference object.
 */
export function convertSchemaObject(
  schemaDef: GoogleApiSchema,
): OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject {
  const result: Record<string, unknown> = {};

  if (schemaDef.type !== undefined) {
    const gtype = schemaDef.type;
    if (gtype === 'object') {
      result['type'] = 'object';

      if (schemaDef.properties !== undefined) {
        const properties: Record<string, unknown> = {};
        for (const [propName, propDef] of Object.entries(
          schemaDef.properties,
        )) {
          properties[propName] = convertSchemaObject(propDef);
        }
        result['properties'] = properties;
      }

      const requiredFields: string[] = [];
      for (const [propName, propDef] of Object.entries(
        schemaDef.properties ?? {},
      )) {
        if (propDef.required) {
          requiredFields.push(propName);
        }
      }
      if (requiredFields.length > 0) {
        result['required'] = requiredFields;
      }
    } else if (gtype === 'array') {
      result['type'] = 'array';
      if (schemaDef.items !== undefined) {
        result['items'] = convertSchemaObject(schemaDef.items);
      }
    } else if (gtype === 'any') {
      result['oneOf'] = [
        {type: 'object'},
        {type: 'array'},
        {type: 'string'},
        {type: 'number'},
        {type: 'boolean'},
        {type: 'null'},
      ];
    } else {
      result['type'] = gtype;
    }
  }

  if (schemaDef.$ref !== undefined) {
    result['$ref'] = normalizeGoogleSchemaRef(schemaDef.$ref);
  }

  if (schemaDef.format !== undefined) {
    result['format'] = schemaDef.format;
  }

  if (schemaDef.enum !== undefined) {
    result['enum'] = schemaDef.enum;
  }

  if (schemaDef.description !== undefined) {
    result['description'] = schemaDef.description;
  }

  if (schemaDef.pattern !== undefined) {
    result['pattern'] = schemaDef.pattern;
  }

  if (schemaDef.default !== undefined) {
    result['default'] = schemaDef.default;
  }

  return result as unknown as
    OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
}

/**
 * Populates `components.schemas` from a Google API Discovery document.
 */
export function convertSchemas(
  googleApiSpec: GoogleApiSpec,
  openapiSpec: OpenAPIV3.Document,
): void {
  openapiSpec.components = openapiSpec.components ?? {};
  openapiSpec.components.schemas = openapiSpec.components.schemas ?? {};

  const schemas = googleApiSpec.schemas ?? {};
  for (const [schemaName, schemaDef] of Object.entries(schemas)) {
    openapiSpec.components.schemas[schemaName] = convertSchemaObject(schemaDef);
  }
}

/**
 * Extracts `{param}` and `{+param}` placeholder names from a URL path.
 */
export function extractPathParameters(path: string): string[] {
  const params: string[] = [];

  for (const match of path.matchAll(/\{\+?([^{}]+)\}/g)) {
    params.push(match[1]);
  }

  return params;
}

/**
 * Converts a Google API parameter definition into an OpenAPI parameter schema.
 */
export function convertParameterSchema(
  paramData: GoogleApiParameter,
): OpenAPIV3.SchemaObject {
  const schema: Record<string, unknown> = {
    type: paramData.type ?? 'string',
  };

  if (paramData.enum !== undefined) {
    schema['enum'] = paramData.enum;
  }

  if (paramData.format !== undefined) {
    schema['format'] = paramData.format;
  }

  if (paramData.default !== undefined) {
    schema['default'] = paramData.default;
  }

  if (paramData.pattern !== undefined) {
    schema['pattern'] = paramData.pattern;
  }

  return schema as unknown as OpenAPIV3.SchemaObject;
}

/**
 * Converts a Google API method definition into an OpenAPI operation object.
 */
export function convertOperation(
  methodData: GoogleApiMethod,
  pathParams: string[],
): OpenAPIV3.OperationObject {
  const parameters: OpenAPIV3.ParameterObject[] = [];

  for (const paramName of pathParams) {
    parameters.push({
      name: paramName,
      in: 'path',
      required: true,
      schema: {type: 'string'},
    });
  }

  const pathParamSet = new Set(pathParams);
  for (const [paramName, paramData] of Object.entries(
    methodData.parameters ?? {},
  )) {
    if (pathParamSet.has(paramName)) {
      continue;
    }

    const location = paramData.location ?? 'query';
    parameters.push({
      name: paramName,
      in: location,
      description: paramData.description ?? '',
      required: location === 'path' ? true : (paramData.required ?? false),
      schema: convertParameterSchema(paramData),
    });
  }

  const response200: OpenAPIV3.ResponseObject = {
    description: 'Successful operation',
  };
  const responseRef = methodData.response?.$ref;
  if (responseRef) {
    response200.content = {
      'application/json': {
        schema: {$ref: normalizeGoogleSchemaRef(responseRef)},
      },
    };
  }

  const operation: OpenAPIV3.OperationObject = {
    operationId: methodData.id ?? '',
    summary: methodData.description ?? '',
    description: methodData.description ?? '',
    parameters,
    responses: {
      '200': response200,
      '400': {description: 'Bad request'},
      '401': {description: 'Unauthorized'},
      '403': {description: 'Forbidden'},
      '404': {description: 'Not found'},
      '500': {description: 'Server error'},
    },
  };

  const requestRef = methodData.request?.$ref;
  if (requestRef) {
    operation.requestBody = {
      description: 'Request body',
      content: {
        'application/json': {
          schema: {$ref: normalizeGoogleSchemaRef(requestRef)},
        },
      },
      required: true,
    };
  }

  const scopes = methodData.scopes ?? [];
  if (scopes.length > 0) {
    operation.security = [{oauth2: scopes}];
  }

  return operation;
}

/**
 * Converts a dictionary of Google API methods into OpenAPI path operations.
 */
export function convertMethods(
  methods: Record<string, GoogleApiMethod>,
  _resourcePath: string,
  openapiSpec: OpenAPIV3.Document,
): void {
  for (const methodData of Object.values(methods)) {
    const httpMethod = (
      methodData.httpMethod ?? 'GET'
    ).toLowerCase() as OpenAPIV3.HttpMethods;
    let restPath = (methodData.path ?? '/').replace(
      /\{\+([^{}]+)\}/g,
      (_match, paramName: string) => `{${paramName}}`,
    );
    if (!restPath.startsWith('/')) {
      restPath = `/${restPath}`;
    }

    const pathParams = extractPathParameters(restPath);
    if (!openapiSpec.paths[restPath]) {
      openapiSpec.paths[restPath] = {};
    }

    const pathItem = openapiSpec.paths[restPath] as Record<
      string,
      OpenAPIV3.OperationObject
    >;
    pathItem[httpMethod] = convertOperation(methodData, pathParams);
  }
}

/**
 * Recursively converts nested Google API resources and their methods into
 * OpenAPI paths.
 */
export function convertResources(
  resources: Record<string, GoogleApiResource>,
  openapiSpec: OpenAPIV3.Document,
  parentPath = '',
): void {
  for (const [resourceName, resourceData] of Object.entries(resources)) {
    const resourcePath = `${parentPath}/${resourceName}`;
    convertMethods(resourceData.methods ?? {}, resourcePath, openapiSpec);

    if (
      resourceData.resources &&
      Object.keys(resourceData.resources).length > 0
    ) {
      convertResources(resourceData.resources, openapiSpec, resourcePath);
    }
  }
}

/**
 * Converts Google API Discovery documents into OpenAPI v3.0.0 specifications.
 */
@experimental
export class GoogleApiToOpenApiConverter {
  readonly apiName: string;
  readonly apiVersion: string;
  googleApiSpec: GoogleApiSpec | null = null;
  openapiSpec: OpenAPIV3.Document;

  constructor(apiName: string, apiVersion: string) {
    this.apiName = apiName;
    this.apiVersion = apiVersion;
    this.openapiSpec = {
      openapi: '3.0.0',
      info: {} as OpenAPIV3.InfoObject,
      servers: [],
      paths: {},
      components: {schemas: {}, securitySchemes: {}},
    };
  }

  /**
   * Fetches the Google API specification from the Google Discovery service.
   */
  @experimental
  async fetchGoogleApiSpec(): Promise<void> {
    try {
      logger.debug(
        `Fetching Google API spec for ${this.apiName} ${this.apiVersion}`,
      );
      const url = `${GOOGLE_DISCOVERY_BASE_URL}/${encodeURIComponent(this.apiName)}/${encodeURIComponent(this.apiVersion)}/rest`;
      const response = await globalThis.fetch(url);
      if (response.status >= 400) {
        throw new Error(
          `HTTP Error ${response.status}: Failed to fetch Google API spec for ${this.apiName} ${this.apiVersion}`,
        );
      }

      const spec = (await response.json()) as GoogleApiSpec | null;
      if (!spec || typeof spec !== 'object' || Object.keys(spec).length === 0) {
        throw new Error('Failed to retrieve API specification');
      }

      this.googleApiSpec = spec;
      logger.debug(`Successfully fetched ${this.apiName} API specification`);
    } catch (error: unknown) {
      logger.error(
        `Error fetching API spec: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Converts the Google API specification into OpenAPI v3 format.
   */
  @experimental
  async convert(): Promise<OpenAPIV3.Document> {
    if (!this.googleApiSpec) {
      await this.fetchGoogleApiSpec();
    }

    const spec = this.googleApiSpec ?? {};
    convertInfo(spec, this.openapiSpec, this.apiName, this.apiVersion);
    convertServers(spec, this.openapiSpec, this.apiName, this.apiVersion);
    convertSecuritySchemes(spec, this.openapiSpec);
    convertSchemas(spec, this.openapiSpec);
    convertResources(spec.resources ?? {}, this.openapiSpec);
    convertMethods(spec.methods ?? {}, '/', this.openapiSpec);

    return this.openapiSpec;
  }

  /**
   * Saves the converted OpenAPI specification to a JSON file.
   */
  @experimental
  saveOpenapiSpec(outputPath: string): void {
    fs.writeFileSync(
      outputPath,
      JSON.stringify(this.openapiSpec, null, 2),
      'utf-8',
    );
    logger.info(`OpenAPI specification saved to ${outputPath}`);
  }
}
