/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/aiplatform';
import {
  Content,
  FunctionDeclaration,
  Part,
  Schema,
  Tool,
  Type,
} from '@google/genai';

type VertexContent = protos.google.cloud.aiplatform.v1beta1.IContent;
type VertexSchema = protos.google.cloud.aiplatform.v1beta1.ISchema;
type VertexPart = protos.google.cloud.aiplatform.v1beta1.IPart;
type VertexTool = protos.google.cloud.aiplatform.v1beta1.ITool;
type VertexFunctionDeclaration =
  protos.google.cloud.aiplatform.v1beta1.IFunctionDeclaration;
type ProtoValue = protos.google.protobuf.IValue;
type ProtoStruct = protos.google.protobuf.IStruct;

/**
 * Converts a JSON value into a `google.protobuf.Value`.
 *
 * The generated gRPC client encodes `Struct` and `Value` fields from their
 * protobuf object form, not from plain JSON, so free-form data such as
 * function call arguments has to be wrapped before it is sent.
 */
export function toProtoValue(value: unknown): ProtoValue {
  if (value === null || value === undefined) {
    return {nullValue: 'NULL_VALUE'};
  }
  if (typeof value === 'number') {
    return {numberValue: value};
  }
  if (typeof value === 'string') {
    return {stringValue: value};
  }
  if (typeof value === 'boolean') {
    return {boolValue: value};
  }
  if (Array.isArray(value)) {
    return {listValue: {values: value.map(toProtoValue)}};
  }
  if (typeof value === 'object') {
    return {structValue: toProtoStruct(value)};
  }
  return {stringValue: String(value)};
}

/** Converts a JSON object into a `google.protobuf.Struct`. */
export function toProtoStruct(value: object): ProtoStruct {
  return {
    fields: Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, toProtoValue(field)]),
    ),
  };
}

/**
 * Converts a `Content` into the Vertex AI content message.
 *
 * Text, inline data, file data, function calls and function responses are
 * kept. Other part kinds carry nothing an evaluation judge reads, and are
 * dropped.
 */
export function toVertexContent(content: Content): VertexContent {
  return {
    role: content.role,
    parts: (content.parts ?? []).flatMap((part) => {
      const vertexPart = toVertexPart(part);
      return vertexPart ? [vertexPart] : [];
    }),
  };
}

function toVertexPart(part: Part): VertexPart | undefined {
  if (part.text !== undefined) {
    return {text: part.text};
  }
  if (part.functionCall) {
    return {
      functionCall: {
        id: part.functionCall.id,
        name: part.functionCall.name,
        args: toProtoStruct(part.functionCall.args ?? {}),
      },
    };
  }
  if (part.functionResponse) {
    return {
      functionResponse: {
        id: part.functionResponse.id,
        name: part.functionResponse.name,
        response: toProtoStruct(part.functionResponse.response ?? {}),
      },
    };
  }
  if (part.inlineData) {
    return {
      inlineData: {
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data,
      },
    };
  }
  if (part.fileData) {
    return {
      fileData: {
        mimeType: part.fileData.mimeType,
        fileUri: part.fileData.fileUri,
      },
    };
  }
  return undefined;
}

/**
 * Converts `Tool` declarations into Vertex AI tool messages.
 *
 * Only function declarations are kept: they are what an evaluation judge
 * reads to understand which tools an agent can call.
 */
export function toVertexTools(tools: readonly Tool[]): VertexTool[] {
  return tools
    .filter((tool) => (tool.functionDeclarations ?? []).length > 0)
    .map((tool) => ({
      functionDeclarations: (tool.functionDeclarations ?? []).map(
        toVertexFunctionDeclaration,
      ),
    }));
}

function toVertexFunctionDeclaration(
  declaration: FunctionDeclaration,
): VertexFunctionDeclaration {
  return {
    name: declaration.name,
    description: declaration.description,
    parametersJsonSchema:
      declaration.parametersJsonSchema !== undefined
        ? toProtoValue(declaration.parametersJsonSchema)
        : undefined,
    parameters: declaration.parameters
      ? toVertexSchema(declaration.parameters)
      : undefined,
    responseJsonSchema:
      declaration.responseJsonSchema !== undefined
        ? toProtoValue(declaration.responseJsonSchema)
        : undefined,
    response: declaration.response
      ? toVertexSchema(declaration.response)
      : undefined,
  };
}

/**
 * Converts a `Schema` into the Vertex AI schema message.
 *
 * Vertex AI has no `NULL` type; such a schema is sent as `nullable` with no
 * type. `default` and `example` are free-form values and are wrapped as
 * `google.protobuf.Value`.
 */
function toVertexSchema(schema: Schema): VertexSchema {
  const {
    type,
    items,
    properties,
    anyOf,
    default: defaultValue,
    example,
    ...rest
  } = schema;
  return {
    ...rest,
    type: type === Type.NULL ? undefined : type,
    nullable: type === Type.NULL ? true : rest.nullable,
    items: items ? toVertexSchema(items) : undefined,
    properties: properties
      ? Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [
            name,
            toVertexSchema(property),
          ]),
        )
      : undefined,
    anyOf: anyOf?.map(toVertexSchema),
    default:
      defaultValue !== undefined ? toProtoValue(defaultValue) : undefined,
    example: example !== undefined ? toProtoValue(example) : undefined,
  };
}
