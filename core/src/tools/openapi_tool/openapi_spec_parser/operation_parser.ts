/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../../utils/experimental.js';

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

  constructor(
    private readonly operation: OpenAPIV3.OperationObject,
    options: {preservePropertyNames?: boolean} = {},
  ) {
    this.preservePropertyNames = options.preservePropertyNames ?? false;
    this.processOperationParameters();
    this.processRequestBody();
    this.processReturnValue();
    this.dedupeParamNames();
  }

  private getParamName(originalName: string): string {
    if (this.preservePropertyNames) {
      return originalName;
    }
    // Simple snake_case conversion
    return originalName
      .replace(/[A-Z]/g, (g) => '_' + g.toLowerCase())
      .replace(/^_/, '');
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
    // Process first mime type only, similar to python
    const firstMimeType = Object.keys(content)[0];
    if (!firstMimeType) {
      return;
    }

    const mediaTypeObject = content[firstMimeType];
    const schema = mediaTypeObject.schema;
    const description = requestBody.description || '';

    if (schema && !('$ref' in schema)) {
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

  private processReturnValue() {
    const responses = this.operation.responses || {};
    // Find first 2xx response
    const validCodes = Object.keys(responses).filter((k) => k.startsWith('2'));
    const min20x = validCodes.sort()[0];

    let returnSchema: OpenAPIV3.SchemaObject = {};

    if (min20x) {
      const response = responses[min20x];
      if (!('$ref' in response) && response.content) {
        const firstMimeType = Object.keys(response.content)[0];
        if (firstMimeType) {
          const schema = response.content[firstMimeType].schema;
          if (schema && !('$ref' in schema)) {
            returnSchema = schema;
          }
        }
      }
    }

    this.returnValue = {
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
      required: required.length > 0 ? required : undefined,
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
}
