/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {snakeCase} from 'lodash-es';

/**
 * Renames TypeScript keywords by adding a prefix.
 *
 * @param s The input string.
 * @param prefix The prefix to add to the keyword.
 * @returns The renamed string.
 */
export function renameTypescriptKeywords(s: string, prefix: string = 'param_'): string {
  const tsKeywords = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
    'false', 'finally', 'for', 'function', 'if', 'import', 'in',
    'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
    'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
    'yield', 'let', 'static'
  ]);

  if (tsKeywords.has(s)) {
    return prefix + s;
  }
  return s;
}

/**
 * Data class representing a function parameter.
 */
export class ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
  description: string;
  pyName: string; // Keeping pyName for compatibility or renaming to tsName if preferred. Let's use pyName for now to match python code if we want it as internal var, or rename to jsName. Let's use name or mappedName.
  required: boolean;

  constructor(params: {
    originalName: string;
    paramLocation: string;
    paramSchema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
    description?: string;
    pyName?: string;
    required?: boolean;
  }) {
    this.originalName = params.originalName;
    this.paramLocation = params.paramLocation;
    this.paramSchema = params.paramSchema;
    this.description = params.description || '';
    this.required = params.required ?? false;

    if (params.pyName) {
      this.pyName = params.pyName;
    } else {
      const inferredName = renameTypescriptKeywords(snakeCase(this.originalName));
      this.pyName = inferredName || this.defaultPyName();
    }

    if (!this.description && 'description' in this.paramSchema) {
      this.description = this.paramSchema.description || '';
    }
  }

  private defaultPyName(): string {
    const locationDefaults: Record<string, string> = {
      'body': 'body',
      'query': 'query_param',
      'path': 'path_param',
      'header': 'header_param',
      'cookie': 'cookie_param',
    };
    return locationDefaults[this.paramLocation] || 'value';
  }

  toString(): string {
    return `${this.pyName}: ${this.getTypeHint()}`;
  }

  toArgString(): string {
    return `${this.pyName}=${this.pyName}`;
  }

  toDictProperty(): string {
    return `"${this.pyName}": ${this.pyName}`;
  }

  getTypeHint(): string {
    return TypeHintHelper.getTypeHint(this.paramSchema);
  }
}

/**
 * Helper class for generating type hints.
 */
export class TypeHintHelper {
  static getTypeHint(schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject): string {
    if ('$ref' in schema) {
      return 'Any'; // Or parse ref
    }

    const paramType = schema.type || 'Any';

    if (paramType === 'integer') {
      return 'number';
    } else if (paramType === 'number') {
      return 'number';
    } else if (paramType === 'boolean') {
      return 'boolean';
    } else if (paramType === 'string') {
      return 'string';
    } else if (paramType === 'array') {
      let itemsType = 'any';
      const arraySchema = schema as OpenAPIV3.ArraySchemaObject;
      if (arraySchema.items && 'type' in arraySchema.items) {
        itemsType = arraySchema.items.type || 'any';
      }

      const typeMap: Record<string, string> = {
        'integer': 'number',
        'number': 'number',
        'boolean': 'boolean',
        'string': 'string',
      };
      return `Array<${typeMap[itemsType] || 'any'}>`;
    } else if (paramType === 'object') {
      return 'Record<string, any>';
    } else {
      return 'any';
    }
  }
}
