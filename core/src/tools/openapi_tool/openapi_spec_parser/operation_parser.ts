/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {snakeCase} from 'lodash-es';
import {ApiParameter, TypeHintHelper, renameTypescriptKeywords} from '../common/common.js';

export class OperationParser {
  private operation: OpenAPIV3.OperationObject;
  private preservePropertyNames: boolean;
  private params: ApiParameter[] = [];
  private returnValue: ApiParameter | null = null;

  constructor(
    operation: OpenAPIV3.OperationObject,
    shouldParse: boolean = true,
    options: { preservePropertyNames?: boolean } = {}
  ) {
    this.operation = operation;
    this.preservePropertyNames = options.preservePropertyNames ?? false;

    if (shouldParse) {
      this.processOperationParameters();
      this.processRequestBody();
      this.processReturnValue();
      this.dedupeParamNames();
    }
  }

  static load(
    operation: OpenAPIV3.OperationObject,
    params: ApiParameter[],
    returnValue: ApiParameter | null = null,
    options: { preservePropertyNames?: boolean } = {}
  ): OperationParser {
    const parser = new OperationParser(operation, false, options);
    parser.params = params;
    parser.returnValue = returnValue;
    return parser;
  }

  private getPyName(originalName: string): string {
    if (this.preservePropertyNames) {
      return renameTypescriptKeywords(originalName);
    }
    return '';
  }

  private processOperationParameters() {
    const parameters = this.operation.parameters || [];
    for (const param of parameters) {
      if ('$ref' in param) {
        continue; // Or resolve ref
      }

      const originalName = param.name;
      const description = param.description || '';
      const location = param.in || '';
      const schema = param.schema || {};

      if ('description' in schema) {
         schema.description = description || schema.description;
      }

      const required = param.required ?? false;

      this.params.push(
        new ApiParameter({
          originalName,
          paramLocation: location,
          paramSchema: schema,
          description,
          required,
          pyName: this.getPyName(originalName),
        })
      );
    }
  }

  private processRequestBody() {
    const requestBody = this.operation.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      return;
    }

    const content = requestBody.content || {};
    if (!content) {
      return;
    }

    // Process first mime type only
    for (const [_, mediaTypeObject] of Object.entries(content)) {
      const schema = mediaTypeObject.schema || {};
      const description = requestBody.description || '';

      if ('type' in schema && schema.type === 'object') {
        const properties = schema.properties || {};
        for (const [propName, propDetails] of Object.entries(properties)) {
          this.params.push(
            new ApiParameter({
              originalName: propName,
              paramLocation: 'body',
              paramSchema: propDetails,
              description: 'description' in propDetails ? propDetails.description : '',
              pyName: this.getPyName(propName),
            })
          );
        }
      } else if ('type' in schema && schema.type === 'array') {
        this.params.push(
          new ApiParameter({
            originalName: 'array',
            paramLocation: 'body',
            paramSchema: schema,
            description,
          })
        );
      } else {
        let paramName = '';
        if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
          paramName = 'body';
        } else if (!('type' in schema) || !schema.type) {
          paramName = 'body';
        }

        this.params.push(
          new ApiParameter({
            originalName: paramName,
            paramLocation: 'body',
            paramSchema: schema,
            description,
          })
         );
      }
      break;
    }
  }

  private dedupeParamNames() {
    const paramsCnt: Record<string, number> = {};
    for (const param of this.params) {
      const name = param.pyName;
      if (!(name in paramsCnt)) {
        paramsCnt[name] = 0;
      } else {
        paramsCnt[name] += 1;
        param.pyName = `${name}_${paramsCnt[name] - 1}`;
      }
    }
  }

  private processReturnValue() {
    const responses = this.operation.responses || {};
    let returnSchema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject = {};

    const validCodes = Object.keys(responses).filter((k) => k.startsWith('2'));
    const min20xCode = validCodes.length > 0 ? validCodes.sort()[0] : null;

    if (min20xCode) {
      const response = responses[min20xCode];
      if ('$ref' in response) {
         // unresolved
      } else if (response.content) {
        for (const [_, contentDetails] of Object.entries(response.content)) {
           if (contentDetails.schema) {
             returnSchema = contentDetails.schema;
             break;
           }
        }
      }
    }

    this.returnValue = new ApiParameter({
      originalName: '',
      paramLocation: '',
      paramSchema: returnSchema,
    });
  }

  getFunctionName(): string {
    const operationId = this.operation.operationId;
    if (!operationId) {
      throw new Error('Operation ID is missing');
    }
    return snakeCase(operationId).slice(0, 60);
  }

  getReturnTypeHint(): string {
    return this.returnValue ? this.returnValue.getTypeHint() : 'any';
  }

  getParameters(): ApiParameter[] {
    return this.params;
  }

  getReturnValue(): ApiParameter | null {
    return this.returnValue;
  }

  getAuthSchemeName(): string {
    if (this.operation.security && this.operation.security.length > 0) {
      const schemeName = Object.keys(this.operation.security[0])[0];
      return schemeName;
    }
    return '';
  }

  getJsonSchema(): Record<string, any> {
    const properties: Record<string, any> = {};
    for (const p of this.params) {
      properties[p.pyName] = p.paramSchema; // Simple schema assignment
    }

    return {
      properties,
      required: this.params.filter((p) => p.required).map((p) => p.pyName),
      title: `${this.operation.operationId || 'unnamed'}_Arguments`,
      type: 'object',
    };
  }

  getAnnotations(): Record<string, any> {
    const annotations: Record<string, any> = {};
    for (const p of this.params) {
      annotations[p.pyName] = p.getTypeHint();
    }
    annotations['return'] = this.getReturnTypeHint();
    return annotations;
  }
}
