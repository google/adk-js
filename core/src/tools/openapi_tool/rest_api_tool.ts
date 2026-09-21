/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {openApiSchemaToGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {applyCredential} from './auth/auth_helpers.js';
import {
  ApiParameter,
  OperationParser,
} from './openapi_spec_parser/operation_parser.js';
import {ToolAuthHandler} from './openapi_spec_parser/tool_auth_handler.js';

import {OperationEndpoint} from './openapi_spec_parser/openapi_spec_parser.js';

/**
 * Longest tool name a `RestApiTool` reports. Gemini limits the length of a
 * function name, and `OperationParser.getFunctionName` already truncates a
 * generated name to the same length.
 */
const MAX_TOOL_NAME_LENGTH = 60;

/** The security scheme types an OpenAPI document may declare. */
const SECURITY_SCHEME_TYPES: readonly string[] = [
  'apiKey',
  'http',
  'oauth2',
  'openIdConnect',
];

/**
 * The parsed operation `createRestApiTool` accepts.
 *
 * `name` and `description` are optional and are derived from the operation
 * when they are absent. `parameters` and `returnValue` carry an operation the
 * caller has already parsed, so its names, locations and schemas stay
 * authoritative.
 */
export interface ParsedOperationInput {
  name?: string;
  description?: string;
  endpoint: OperationEndpoint;
  operation: OpenAPIV3.OperationObject;
  authScheme?: OpenAPIV3.SecuritySchemeObject;
  authCredential?: AuthCredential;
  parameters?: ApiParameter[];
  returnValue?: ApiParameter;
}

function readSchemeType(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'type' in value
    ? value.type
    : undefined;
}

function isSecurityScheme(
  value: unknown,
): value is OpenAPIV3.SecuritySchemeObject {
  const type = readSchemeType(value);
  return typeof type === 'string' && SECURITY_SCHEME_TYPES.includes(type);
}

/**
 * Serializes cookie parameters into a `Cookie` header value.
 *
 * `fetch` has no cookie option, so the header is the only place a cookie
 * parameter can go. The value comes from the model, so it is percent-encoded
 * for the same reason a path parameter is.
 */
function serializeCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

@experimental
export class RestApiTool extends BaseTool {
  private operationParser: OperationParser;

  private headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  private credentialKey?: string;

  constructor(
    name: string,
    description: string,
    private readonly endpoint: OperationEndpoint,
    private readonly operation: OpenAPIV3.OperationObject,
    private authScheme?: OpenAPIV3.SecuritySchemeObject,
    private authCredential?: AuthCredential,
    options: {
      preservePropertyNames?: boolean;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
      credentialKey?: string;
      operationParser?: OperationParser;
    } = {},
  ) {
    super({name: name.slice(0, MAX_TOOL_NAME_LENGTH), description});
    this.authScheme = authScheme;
    this.authCredential = authCredential;
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;
    this.operationParser =
      options.operationParser ?? new OperationParser(operation, options);
  }

  @experimental
  public configureAuthScheme(authScheme: OpenAPIV3.SecuritySchemeObject) {
    this.authScheme = authScheme;
  }

  @experimental
  public configureAuthCredential(authCredential: AuthCredential) {
    this.authCredential = authCredential;
  }

  @experimental
  public configureCredentialKey(credentialKey: string) {
    this.credentialKey = credentialKey;
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: openApiSchemaToGeminiSchema(
        this.operationParser.getJsonSchema(),
      ),
    };
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const context = request.toolContext as Context;
    const args = request.args;

    const authHandler = ToolAuthHandler.fromToolContext(
      context,
      this.authScheme,
      this.authCredential,
      {credentialKey: this.credentialKey},
    );

    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    const credential = authResult.authCredential;

    // Prepare request
    const method = this.endpoint.method.toUpperCase();
    const {
      url: initialUrl,
      headers,
      body: parsedBody,
      bodyData,
      cookies,
    } = prepareRequestParams(
      this.endpoint,
      this.operationParser.getParameters(),
      args,
    );

    // Handle body
    const body = prepareRequestBody(
      this.operation.requestBody,
      parsedBody,
      bodyData,
      headers,
    );

    // Prefer the scheme on the result: it is the copy the handler prepared the
    // credential against, so the two cannot disagree if this tool's own field
    // was mutated in between. A result with no scheme means the tool has none.
    const url = applyCredential(
      initialUrl,
      headers,
      credential,
      authResult.authScheme ?? this.authScheme,
    );

    // Apply dynamic headers from provider
    if (this.headerProvider) {
      const providerHeaders = this.headerProvider(context);
      Object.assign(headers, providerHeaders);
    }

    const hasCookieHeader = Object.keys(headers).some(
      (header) => header.toLowerCase() === 'cookie',
    );
    if (Object.keys(cookies).length > 0 && !hasCookieHeader) {
      headers['Cookie'] = serializeCookieHeader(cookies);
    }

    // The reference issues the request OUTSIDE its try (`rest_api_tool.py:465`),
    // so a transport failure -- DNS, refused connection, TLS -- propagates to
    // the caller. Catching it here and returning `{error: ...}` would hand the
    // model a string to reason about where adk-python raises, so the fetch
    // stays outside too.
    const response = await globalThis.fetch(url, {
      method,
      headers,
      // eslint-disable-next-line no-undef
      body: body as BodyInit,
    });

    // `raise_for_status()` -> the HTTPError branch (`rest_api_tool.py:471`).
    //
    // `status >= 400`, not `!response.ok`. `raise_for_status()` raises only for
    // 400-599, while `response.ok` is false for any non-2xx -- so an
    // unfollowed 3xx (a 304, which neither `requests` nor `fetch` follows)
    // takes the error branch here and falls through to `.json()` there,
    // yielding `{"text": ""}` on the empty body.
    if (response.status >= 400) {
      const errorDetails = await response.text();
      return {
        error:
          `Tool ${this.name} execution failed. Analyze this execution error ` +
          `and your inputs. Retry with adjustments if applicable. But make ` +
          `sure don't retry more than 3 times. Execution Error: ${errorDetails}`,
      };
    }

    // `return response.json()` with a `ValueError` fallback to
    // `{"text": response.text}` (`rest_api_tool.py:472, 481`). Decode first and
    // fall back on failure rather than testing `content-type`: a malformed body
    // served as `application/json` is exactly the case the reference's
    // `ValueError` branch is for, and a content-type test would instead throw.
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return {text};
    }
  }
}

export interface PreparedParams {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bodyData: Record<string, unknown>;
  cookies: Record<string, string>;
}

/**
 * Percent-encodes a model-supplied value for substitution into a single URL
 * path segment.
 *
 * Path parameter values come from the LLM and are therefore untrusted. Left
 * raw, a `/`, `?` or `#` lets the value escape the segment, and the endpoint,
 * declared by the OpenAPI spec. Values that are exactly `.` or `..` are
 * rejected rather than encoded, because URL normalization resolves a
 * percent-encoded dot-segment (`%2E%2E`) exactly like a literal one.
 *
 * @throws {Error} If the value is a relative path segment.
 */
function encodePathParamValue(name: string, value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(
      `Invalid value for path parameter '${name}': relative path segments ` +
        `('.' and '..') are not allowed.`,
    );
  }
  return encodeURIComponent(value);
}

export function prepareRequestParams(
  endpoint: OperationEndpoint,
  parameters: ApiParameter[],
  args: Record<string, unknown>,
): PreparedParams {
  const headers: Record<string, string> = {};
  const queryParams = new URLSearchParams();
  const cookies: Record<string, string> = {};
  let body: unknown = undefined;

  const paramsMap = new Map(parameters.map((p) => [p.name, p]));
  const pathParams: Record<string, string> = {};
  const bodyData: Record<string, unknown> = {};

  for (const [argName, argValue] of Object.entries(args)) {
    const param = paramsMap.get(argName);
    if (!param) continue;

    const originalName = param.originalName;
    const location = param.paramLocation;

    if (location === 'path') {
      pathParams[originalName] = encodePathParamValue(
        originalName,
        String(argValue),
      );
    } else if (location === 'query') {
      // An unset query parameter is not sent. `0` and `false` are sent, unlike
      // the reference implementation, which drops every falsy value and so
      // loses `?count=0` and `?flag=false`.
      if (argValue !== undefined && argValue !== null && argValue !== '') {
        queryParams.append(originalName, String(argValue));
      }
    } else if (location === 'header') {
      headers[originalName] = String(argValue);
    } else if (location === 'cookie') {
      cookies[originalName] = String(argValue);
    } else if (location === 'body') {
      if (
        originalName === 'body' ||
        originalName === 'array' ||
        originalName === ''
      ) {
        body = argValue;
      } else {
        bodyData[originalName] = argValue;
      }
    }
  }

  // Placeholders are resolved against the path only, so a path parameter can
  // never reach the host. `hasOwn`, because a spec may name a path parameter
  // `constructor`, which a bare lookup would resolve off Object.prototype.
  const resolvedPath = endpoint.path.replace(
    /\{([^{}]+)\}/g,
    (placeholder, name: string) =>
      Object.hasOwn(pathParams, name) ? pathParams[name] : placeholder,
  );
  // A base URL ending in `/` would otherwise meet a path starting with `/` and
  // produce a double slash.
  const baseUrl = endpoint.baseUrl.endsWith('/')
    ? endpoint.baseUrl.slice(0, -1)
    : endpoint.baseUrl;
  let url = `${baseUrl}${resolvedPath}`;

  // Extract query parameters from path if any
  const urlParts = url.split('?');
  if (urlParts.length > 1) {
    const pathQueryParams = new URLSearchParams(urlParts[1]);
    for (const [key, value] of pathQueryParams.entries()) {
      queryParams.append(key, value);
    }
    url = urlParts[0];
  }

  // Append query parameters
  const queryString = queryParams.toString();
  if (queryString) {
    url += `?${queryString}`;
  }

  return {url, headers, body, bodyData, cookies};
}

/**
 * Whether `value` can go on the wire as an `application/octet-stream` body
 * without conversion. `fetch` accepts each of these as a `BodyInit`.
 */
function isRawBody(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Blob
  );
}

export function prepareRequestBody(
  requestBody:
    | OpenAPIV3.RequestBodyObject
    | OpenAPIV3.ReferenceObject
    | undefined,
  body: unknown,
  bodyData: Record<string, unknown>,
  headers: Record<string, string>,
): unknown {
  const finalData =
    body !== undefined
      ? body
      : Object.keys(bodyData).length > 0
        ? bodyData
        : undefined;

  if (requestBody && 'content' in requestBody) {
    const content = requestBody.content;
    // Process only the first mime type
    const mimeType = Object.keys(content)[0];
    if (mimeType && finalData !== undefined) {
      if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
        headers['Content-Type'] = mimeType;
        return typeof finalData === 'string'
          ? finalData
          : JSON.stringify(finalData);
      } else if (mimeType === 'application/x-www-form-urlencoded') {
        return new URLSearchParams(finalData as Record<string, string>);
      } else if (mimeType === 'multipart/form-data') {
        const formData = new FormData();
        if (typeof finalData === 'object' && finalData !== null) {
          for (const [key, value] of Object.entries(finalData)) {
            formData.append(key, String(value));
          }
        }
        return formData;
      } else if (mimeType === 'application/octet-stream') {
        headers['Content-Type'] = mimeType;
        return isRawBody(finalData) ? finalData : String(finalData);
      } else if (mimeType === 'text/plain') {
        headers['Content-Type'] = mimeType;
        return String(finalData);
      }
    }
  } else if (finalData !== undefined) {
    // Fallback to JSON if no requestBody content specified but data exists
    headers['Content-Type'] = 'application/json';
    return typeof finalData === 'string'
      ? finalData
      : JSON.stringify(finalData);
  }
  return undefined;
}

/**
 * Builds a `RestApiTool` from a parsed operation.
 *
 * @param parsed The operation, with the parameters already parsed when the
 *   caller has them.
 * @param options Options forwarded to the tool and to its operation parser.
 * @returns The tool for that operation.
 */
export function createRestApiTool(
  parsed: ParsedOperationInput,
  options: {
    preservePropertyNames?: boolean;
    headerProvider?: (context: ReadonlyContext) => Record<string, string>;
    credentialKey?: string;
  } = {},
): RestApiTool {
  const operationParser = parsed.parameters
    ? OperationParser.load(
        parsed.operation,
        parsed.parameters,
        parsed.returnValue,
      )
    : new OperationParser(parsed.operation, options);

  return new RestApiTool(
    parsed.name ?? operationParser.getFunctionName(),
    parsed.description ?? operationParser.getDescription(),
    parsed.endpoint,
    parsed.operation,
    parsed.authScheme,
    parsed.authCredential,
    {...options, operationParser},
  );
}

/**
 * Builds a `RestApiTool` from the JSON string form of a parsed operation.
 *
 * This is the only entry point that accepts undecoded input, so it is where
 * the auth scheme is checked. A scheme reaching `createRestApiTool` as an
 * object is already constrained by its type.
 *
 * @param parsedOperationJson A serialized {@link ParsedOperationInput}.
 * @returns The tool for that operation.
 * @throws {Error} If the auth scheme does not declare a known `type`.
 */
export function createRestApiToolFromJson(
  parsedOperationJson: string,
): RestApiTool {
  const parsed = JSON.parse(parsedOperationJson) as ParsedOperationInput;
  if (parsed.authScheme && !isSecurityScheme(parsed.authScheme)) {
    throw new Error(
      `Unsupported security scheme type: ${JSON.stringify(readSchemeType(parsed.authScheme))}. ` +
        `Expected one of: ${SECURITY_SCHEME_TYPES.join(', ')}.`,
    );
  }
  return createRestApiTool(parsed);
}
