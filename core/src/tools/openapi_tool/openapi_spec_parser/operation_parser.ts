/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {
  renameReservedKeywords,
  toSnakeCaseName,
} from '../../../utils/case_utils.js';
import {experimental} from '../../../utils/experimental.js';
import {
  generateParamDoc,
  generateReturnDoc,
  getTypeHint,
} from '../common/common.js';

export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string; // The name used in the generated tool schema (may be snake_cased)
  required: boolean;
}

/**
 * Parses an OpenAPI OperationObject and extracts its parameters, request body, and return value.
 *
 * It maps OpenAPI parameters and request bodies into a flat list of `ApiParameter` objects
 * that are compatible with Gemini's tool function declarations.
 */
@experimental
export class OperationParser {
  private params: ApiParameter[] = [];
  private returnValue?: ApiParameter;
  private preservePropertyNames: boolean;
  private readonly operation: OpenAPIV3.OperationObject;

  /**
   * @param operation The operation to parse. A string is parsed as JSON, and a
   *     plain object is used as given.
   * @param options.preservePropertyNames Keeps the original parameter and
   *     function names instead of converting them to snake_case.
   * @param options.shouldParse Whether to parse the operation during
   *     construction. Defaults to `true`.
   */
  constructor(
    operation: OpenAPIV3.OperationObject | Record<string, unknown> | string,
    options: {preservePropertyNames?: boolean; shouldParse?: boolean} = {},
  ) {
    // adk-js has no runtime schema validation for an OperationObject, so an
    // untyped input is narrowed here rather than validated.
    this.operation = (
      typeof operation === 'string' ? JSON.parse(operation) : operation
    ) as OpenAPIV3.OperationObject;
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    if (options.shouldParse ?? true) {
      this.processOperationParameters();
      this.processRequestBody();
      this.returnValue = this.processReturnValue();
      this.dedupeParamNames();
    }
  }

  /**
   * Builds a parser from parameters that were already parsed, without walking
   * the operation again.
   *
   * @param operation The operation the parameters came from.
   * @param params The parsed parameters.
   * @param returnValue The parsed return value, if any.
   * @returns A parser holding the given parameters.
   */
  @experimental
  static load(
    operation: OpenAPIV3.OperationObject | Record<string, unknown> | string,
    params: ApiParameter[],
    returnValue?: ApiParameter,
  ): OperationParser {
    // `new this` rather than `new OperationParser`: the `@experimental` class
    // decorator returns a subclass, and the identifier inside the class body
    // binds to the undecorated inner class.
    const parser = new this(operation, {shouldParse: false});
    parser.params = params;
    parser.returnValue = returnValue;
    return parser;
  }

  private getParamName(originalName: string): string {
    if (this.preservePropertyNames) {
      return originalName;
    }
    // Both steps, in the reference's order: `rename_python_keywords(
    // to_snake_case(original_name))` (`common.py:105-108`). The rename was
    // missing here, so a specification parameter named `in` stayed `in` where
    // adk-python produces `param_in` -- and this name goes straight into the
    // function declaration the model sees.
    return renameReservedKeywords(toSnakeCaseName(originalName));
  }

  private processOperationParameters() {
    const parameters = this.operation.parameters || [];
    for (const param of parameters) {
      // Assume resolved references for now
      if ('name' in param) {
        const originalName = param.name;
        const description = param.description || '';
        const location = param.in || '';
        const schema = (param.schema as OpenAPIV3.SchemaObject) || {};

        this.params.push({
          originalName,
          paramLocation: location,
          paramSchema: schema,
          description,
          required: param.required || false,
          name: this.getParamName(originalName),
        });
      }
    }
  }

  private processRequestBody() {
    const requestBody = this.operation.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      return;
    }

    const content = requestBody.content || {};
    // Process the first mime type only.
    const firstMimeType = Object.keys(content)[0];
    if (!firstMimeType) {
      return;
    }

    const mediaTypeObject = content[firstMimeType];
    // A media type may omit `schema`, which describes an unconstrained payload
    // rather than the absence of one. adk-python reads it as an empty schema
    // and still advertises a `body` argument for it.
    const schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject =
      mediaTypeObject.schema ?? {};
    const description = requestBody.description || '';

    if (!('$ref' in schema)) {
      if (schema.type === 'object') {
        const properties = schema.properties || {};
        if (Object.keys(properties).length > 0) {
          for (const [propName, propDetails] of Object.entries(properties)) {
            if (!('$ref' in propDetails)) {
              this.params.push({
                originalName: propName,
                paramLocation: 'body',
                paramSchema: propDetails,
                description: propDetails.description,
                required: (schema.required || []).includes(propName),
                name: this.getParamName(propName),
              });
            }
          }
        } else {
          this.params.push({
            originalName: '',
            paramLocation: 'body',
            paramSchema: schema,
            description,
            required: true,
            name: 'body',
          });
        }
      } else if (schema.type === 'array') {
        this.params.push({
          originalName: 'array',
          paramLocation: 'body',
          paramSchema: schema,
          description,
          required: true,
          name: 'body',
        });
      } else {
        this.params.push({
          originalName: 'body',
          paramLocation: 'body',
          paramSchema: schema,
          description,
          required: true,
          name: 'body',
        });
      }
    }
  }

  private processReturnValue(): ApiParameter {
    const responses = this.operation.responses || {};
    // Find first 2xx response
    const validCodes = Object.keys(responses).filter((k) => k.startsWith('2'));
    const min20x = validCodes.sort()[0];

    let returnSchema: OpenAPIV3.SchemaObject = {};

    if (min20x) {
      const response = responses[min20x];
      if (!('$ref' in response) && response.content) {
        // Some media types omit a schema; keep scanning until one declares it.
        for (const mediaType of Object.values(response.content)) {
          const schema = mediaType.schema;
          if (schema && !('$ref' in schema)) {
            returnSchema = schema;
            break;
          }
        }
      }
    }

    return {
      originalName: '',
      paramLocation: '',
      paramSchema: returnSchema,
      required: true,
      name: 'return',
    };
  }

  private dedupeParamNames() {
    const nameCounts = new Map<string, number>();
    for (const param of this.params) {
      const name = param.name;
      const count = nameCounts.get(name) || 0;
      if (count > 0) {
        param.name = `${name}_${count}`;
      }
      nameCounts.set(name, count + 1);
    }
  }

  /**
   * Gets the list of parsed parameters extracted from the OpenAPI operation.
   *
   * @returns An array of parsed parameters.
   */
  @experimental
  public getParameters(): ApiParameter[] {
    return this.params;
  }

  /**
   * Generates a JSON schema representing the arguments of the tool function call.
   *
   * @returns A JSON Schema object.
   */
  @experimental
  public getJsonSchema(): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of this.params) {
      properties[param.name] = param.paramSchema;
      if (param.required) {
        required.push(param.name);
      }
    }

    return {
      type: 'object',
      properties,
      required,
      title: `${this.operation.operationId || 'unnamed'}_Arguments`,
    };
  }

  /**
   * Gets a valid tool function name derived from the operation's operationId.
   *
   * @throws {Error} If the operation does not have an operationId.
   * @returns A string representing the function name.
   */
  @experimental
  public getFunctionName(): string {
    const operationId = this.operation.operationId;
    if (!operationId) {
      throw new Error('Operation ID is missing');
    }
    return this.getParamName(operationId).substring(0, 60);
  }

  /**
   * Gets the description of the tool, derived from the operation's description or summary.
   *
   * @returns A string representing the description.
   */
  @experimental
  public getDescription(): string {
    return this.operation.description || this.operation.summary || '';
  }

  /**
   * Gets the name of the security scheme this operation declares.
   *
   * Only operation-level security is considered. Document-level security is
   * not visible from here, so a caller that needs the fallback uses
   * `OpenApiSpecParser` instead.
   *
   * @returns The first declared scheme name, or `''` when the operation
   *     declares none.
   */
  @experimental
  public getAuthSchemeName(): string {
    const security = this.operation.security ?? [];
    return security.length > 0 ? (Object.keys(security[0])[0] ?? '') : '';
  }

  /**
   * Gets the parsed return value of the operation.
   *
   * @returns The return value, or `undefined` when the parser was constructed
   *     with `shouldParse: false` and nothing was loaded.
   */
  @experimental
  public getReturnValue(): ApiParameter | undefined {
    return this.returnValue;
  }

  /**
   * Gets the Python-style type hint of the return value.
   *
   * @returns A type name such as `str`, or `Any` when the operation declares
   *     no typed 2xx response.
   */
  @experimental
  public getReturnTypeHint(): string {
    return getTypeHint(this.returnValue?.paramSchema);
  }

  /**
   * Generates a Python-style docstring describing the operation, every
   * parameter and the return value.
   *
   * The type names inside it are Python's, because the artifact is a docstring
   * in adk-python's format and the same text reaches the model in both SDKs.
   *
   * @returns The generated docstring.
   */
  @experimental
  public getPydocString(): string {
    const description =
      this.operation.summary || this.operation.description || '';
    const argLines = this.params
      .map((param) => `    ${generateParamDoc(param)}`)
      .join('\n');
    const returnDoc = generateReturnDoc(this.operation.responses ?? {});
    const returnBlock = returnDoc ? `\n\n${returnDoc}` : '';
    return `"""${description}\n\nArgs:\n${argLines}${returnBlock}\n"""`;
  }
}
