/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z} from 'zod';

const MCPToolSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.unknown()).optional(),
  required: z.string().array().optional(),
});
type MCPToolSchema = z.infer<typeof MCPToolSchema>;

function toGeminiType(mcpType: string): Type {
  switch (mcpType.toLowerCase()) {
    case 'text':
    case 'string':
      return Type.STRING;
    case 'number':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'integer':
      return Type.INTEGER;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    default:
      return Type.TYPE_UNSPECIFIED;
  }
}

export function toGeminiSchema(mcp_schema?: MCPToolSchema): Schema|undefined {
  if (!mcp_schema) {
    return undefined;
  }

  const gemini_schema: Schema = {
    type: Type.OBJECT,
    properties: {},
    required: mcp_schema.required,
  };

  if (mcp_schema.properties && gemini_schema.properties) {
    for (const name in mcp_schema.properties) {
      // TODO: revisit this.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const property = mcp_schema.properties[name] as any;
      gemini_schema.properties[name] = {
        type: toGeminiType(property.type),
        description: property.description,
      };
    }
  }
  return gemini_schema;
}
