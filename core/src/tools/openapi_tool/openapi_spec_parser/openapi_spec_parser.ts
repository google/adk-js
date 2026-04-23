/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../../utils/experimental.js';
import {ApiParameter, OperationParser} from './operation_parser.js';

export interface OperationEndpoint {
  baseUrl: string;
  path: string;
  method: string;
}

export interface ParsedOperation {
  name: string;
  description: string;
  endpoint: OperationEndpoint;
  operation: OpenAPIV3.OperationObject;
  parameters: ApiParameter[];
  returnValue?: ApiParameter;
  authScheme?: OpenAPIV3.SecuritySchemeObject;
}

@experimental
export class OpenApiSpecParser {
  private preservePropertyNames: boolean;

  constructor(options: {preservePropertyNames?: boolean} = {}) {
    this.preservePropertyNames = options.preservePropertyNames ?? false;
  }

  @experimental
  public parse(openapiSpec: OpenAPIV3.Document): ParsedOperation[] {
    const resolvedSpec = this.resolveReferences(openapiSpec);
    // Skipping sanitizeSchemaTypes for now unless we find it's needed for Gemini
    return this.collectOperations(resolvedSpec);
  }

  private resolveReferences(spec: OpenAPIV3.Document): OpenAPIV3.Document {
    const resolvedCache = new Map<string, unknown>();
    const specCopy = JSON.parse(JSON.stringify(spec)); // Deep copy

    const resolveRef = (
      refString: string,
      currentDoc: OpenAPIV3.Document,
    ): unknown => {
      const parts = refString.split('/');
      if (parts[0] !== '#') {
        throw new Error(`External references not supported: ${refString}`);
      }

      let current: unknown = currentDoc;
      for (const part of parts.slice(1)) {
        if (
          typeof current === 'object' &&
          current !== null &&
          part in current
        ) {
          current = (current as Record<string, unknown>)[part];
        } else {
          return undefined;
        }
      }
      return current;
    };

    const recursiveResolve = (
      obj: unknown,
      currentDoc: OpenAPIV3.Document,
      seenRefs = new Set<string>(),
    ): unknown => {
      if (typeof obj !== 'object' || obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map((item) => recursiveResolve(item, currentDoc, seenRefs));
      }

      const objRecord = obj as Record<string, unknown>;
      if ('$ref' in objRecord && typeof objRecord['$ref'] === 'string') {
        const refString = objRecord['$ref'] as string;

        if (seenRefs.has(refString) && !resolvedCache.has(refString)) {
          // Circular reference detected. Break cycle.
          const copy = {...objRecord};
          delete copy['$ref'];
          return copy;
        }

        seenRefs.add(refString);

        if (resolvedCache.has(refString)) {
          return resolvedCache.get(refString);
        }

        let resolvedValue = resolveRef(refString, currentDoc);
        if (resolvedValue !== undefined) {
          resolvedValue = recursiveResolve(resolvedValue, currentDoc, seenRefs);
          resolvedCache.set(refString, resolvedValue);
          return resolvedValue;
        } else {
          return obj;
        }
      }

      const newDict: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(objRecord)) {
        newDict[key] = recursiveResolve(value, currentDoc, seenRefs);
      }
      return newDict;
    };

    return recursiveResolve(specCopy, specCopy) as OpenAPIV3.Document;
  }

  private collectOperations(spec: OpenAPIV3.Document): ParsedOperation[] {
    const operations: ParsedOperation[] = [];
    const baseUrl = spec.servers?.[0]?.url || '';

    const globalSecurity = spec.security || [];
    let globalSchemeName: string | undefined;
    if (globalSecurity.length > 0) {
      globalSchemeName = Object.keys(globalSecurity[0])[0];
    }

    const authSchemes =
      (spec.components?.securitySchemes as Record<
        string,
        OpenAPIV3.SecuritySchemeObject
      >) || {};

    for (const [path, pathItem] of Object.entries(spec.paths || {})) {
      if (!pathItem) continue;

      const methods = [
        'get',
        'post',
        'put',
        'delete',
        'patch',
        'head',
        'options',
        'trace',
      ] as const;

      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;

        // Merge path level parameters
        const pathParams = pathItem.parameters || [];
        const opParams = operation.parameters || [];
        operation.parameters = [...opParams, ...pathParams];

        if (!operation.operationId) {
          // Generate operation ID if missing
          operation.operationId = `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
        }

        const parser = new OperationParser(operation, {
          preservePropertyNames: this.preservePropertyNames,
        });

        let authSchemeName: string | undefined;
        if (operation.security && operation.security.length > 0) {
          authSchemeName = Object.keys(operation.security[0])[0];
        }
        authSchemeName = authSchemeName || globalSchemeName;

        const authScheme = authSchemeName
          ? authSchemes[authSchemeName]
          : undefined;

        operations.push({
          name: parser.getFunctionName(),
          description: parser.getDescription(),
          endpoint: {baseUrl, path, method},
          operation: operation,
          parameters: parser.getParameters(),
          authScheme: authScheme,
        });
      }
    }

    return operations;
  }
}
