/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, Message, Role} from '@a2a-js/sdk';
import {
  createModelContent,
  createUserContent,
  CodeExecutionResult as GenAICodeExecutionResult,
  Content as GenAIContent,
  ExecutableCode as GenAIExecutableCode,
  FunctionCall as GenAIFunctionCall,
  FunctionResponse as GenAIFunctionResponse,
  Part as GenAIPart,
  VideoMetadata,
} from '@google/genai';
import {createTextPart} from './a2a_event.js';
import {A2AMetadataKeys} from './metadata_converter_utils.js';

/**
 * An A2A part of one content type.
 */
type A2APartOf<C extends NonNullable<A2APart['content']>['$case']> = A2APart & {
  content: Extract<NonNullable<A2APart['content']>, {$case: C}>;
};

/** An A2A text part. */
type A2ATextPart = A2APartOf<'text'>;
/** An A2A file part: inline bytes or a URL. */
type A2AFilePart = A2APartOf<'raw' | 'url'>;
/** An A2A structured data part. */
type A2ADataPart = A2APartOf<'data'>;

/**
 * Decodes base64, the encoding GenAI uses for inline data, into the bytes an
 * A2A v1.0 part carries.
 */
function base64ToBytes(base64: string): Buffer {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(base64, 'base64');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes as Buffer;
}

/** Encodes the bytes of an A2A v1.0 part as base64 for GenAI inline data. */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The types of data parts.
 */
enum DataPartType {
  FUNCTION_CALL = 'function_call',
  FUNCTION_RESPONSE = 'function_response',
  CODE_EXEC_RESULT = 'code_execution_result',
  CODE_EXECUTABLE_CODE = 'executable_code',
}

/**
 * Converts an array of GenAI Parts to A2A Parts.
 *
 * @param parts - The GenAI parts to convert. Defaults to an empty array.
 * @param longRunningToolIDs - IDs of function calls that are long-running.
 * @returns An array of A2A parts.
 */
export function toA2AParts(
  parts: GenAIPart[] = [],
  longRunningToolIDs: string[] = [],
): A2APart[] {
  return parts.map((part) => toA2APart(part, longRunningToolIDs));
}

/**
 * Converts a single GenAI Part to the appropriate A2A Part type.
 *
 * @param part - The GenAI part to convert.
 * @param longRunningToolIDs - IDs of function calls that are long-running.
 * @returns The corresponding A2A part (text, file, or data).
 */
export function toA2APart(
  part: GenAIPart,
  longRunningToolIDs?: string[],
): A2APart {
  if (part.text !== undefined && part.text !== null) {
    return toA2ATextPart(part);
  }

  if (part.inlineData || part.fileData) {
    return toA2AFilePart(part);
  }

  return toA2ADataPart(part, longRunningToolIDs);
}

/**
 * Converts a GenAI Text Part to an A2A Text Part.
 *
 * @param part - The GenAI part containing a text field.
 * @returns An A2A text part, with thought metadata attached if applicable.
 */
export function toA2ATextPart(part: GenAIPart): A2APart {
  return createTextPart(
    part.text || '',
    part.thought ? {[A2AMetadataKeys.THOUGHT]: true} : undefined,
  );
}

/**
 * Converts a GenAI File Part to an A2A File Part.
 *
 * @param part - The GenAI part containing `fileData` or `inlineData`.
 * @returns An A2A file part with URI or bytes depending on the source.
 * @throws {Error} If the part contains neither `fileData` nor `inlineData`.
 */
export function toA2AFilePart(part: GenAIPart): A2APart {
  const metadata: Record<string, unknown> = {};
  if (part.videoMetadata) {
    metadata[A2AMetadataKeys.VIDEO_METADATA] = part.videoMetadata;
  }

  if (part.fileData) {
    return {
      content: {$case: 'url', value: part.fileData.fileUri || ''},
      metadata,
      filename: '',
      mediaType: part.fileData.mimeType || '',
    };
  }

  if (part.inlineData) {
    return {
      content: {$case: 'raw', value: base64ToBytes(part.inlineData.data || '')},
      metadata,
      filename: '',
      mediaType: part.inlineData.mimeType || '',
    };
  }

  throw new Error(`Not a file part: ${JSON.stringify(part)}`);
}

/**
 * Converts a GenAI Data Part (function call/response or code) to an A2A Data Part.
 *
 * @param part - The GenAI part containing structured data.
 * @param longRunningToolIDs - IDs of function calls that are long-running.
 * @returns An A2A data part with the appropriate type metadata.
 */
export function toA2ADataPart(
  part: GenAIPart,
  longRunningToolIDs: string[] = [],
): A2APart {
  let dataPartType: DataPartType;
  let data:
    | GenAIFunctionCall
    | GenAIFunctionResponse
    | GenAIExecutableCode
    | GenAICodeExecutionResult;

  if (part.functionCall) {
    dataPartType = DataPartType.FUNCTION_CALL;
    data = part.functionCall;
  } else if (part.functionResponse) {
    dataPartType = DataPartType.FUNCTION_RESPONSE;
    data = part.functionResponse;
  } else if (part.executableCode) {
    dataPartType = DataPartType.CODE_EXECUTABLE_CODE;
    data = part.executableCode;
  } else if (part.codeExecutionResult) {
    dataPartType = DataPartType.CODE_EXEC_RESULT;
    data = part.codeExecutionResult;
  } else {
    return {
      content: {$case: 'data', value: {}},
      metadata: {},
      filename: '',
      mediaType: '',
    };
  }

  const metadata: Record<string, unknown> = {
    [A2AMetadataKeys.DATA_PART_TYPE]: dataPartType,
  };

  if (
    part.functionCall &&
    part.functionCall.id &&
    longRunningToolIDs.includes(part.functionCall.id)
  ) {
    metadata[A2AMetadataKeys.IS_LONG_RUNNING] = true;
  }

  if (
    part.functionResponse &&
    part.functionResponse.id &&
    longRunningToolIDs.includes(part.functionResponse.id)
  ) {
    metadata[A2AMetadataKeys.IS_LONG_RUNNING] = true;
  }

  return {
    content: {$case: 'data', value: data},
    metadata,
    filename: '',
    mediaType: '',
  };
}

/**
 * Converts an A2A Message to a GenAI Content object.
 *
 * @param a2aMessage - The A2A message to convert.
 * @returns A GenAI user or model content object based on the message role.
 */
export function toGenAIContent(a2aMessage: Message): GenAIContent {
  const parts = toGenAIParts(a2aMessage.parts);

  return a2aMessage.role === Role.ROLE_USER
    ? createUserContent(parts)
    : createModelContent(parts);
}

/**
 * Converts an array of A2A Parts to GenAI Parts.
 *
 * @param a2aParts - The A2A parts to convert.
 * @returns An array of GenAI parts.
 */
export function toGenAIParts(a2aParts: A2APart[]): GenAIPart[] {
  return a2aParts.map((a2aPart) => toGenAIPart(a2aPart));
}

/**
 * Converts a single A2A Part to the appropriate GenAI Part type.
 *
 * @param a2aPart - The A2A part to convert.
 * @returns The corresponding GenAI part.
 * @throws {Error} If the A2A part has no recognized content.
 */
export function toGenAIPart(a2aPart: A2APart): GenAIPart {
  switch (a2aPart.content?.$case) {
    case 'text':
      return toGenAIPartText(a2aPart as A2ATextPart);
    case 'raw':
    case 'url':
      return toGenAIPartFile(a2aPart as A2AFilePart);
    case 'data':
      return toGenAIPartData(a2aPart as A2ADataPart);
    default:
      throw new Error(`Unknown part content: ${JSON.stringify(a2aPart)}`);
  }
}

/**
 * Converts an A2A Text Part to a GenAI Part.
 *
 * @param a2aPart - The A2A text part to convert.
 * @returns A GenAI part with `text` and optional `thought` flag.
 */
export function toGenAIPartText(a2aPart: A2ATextPart): GenAIPart {
  return {
    text: a2aPart.content.value,
    thought: !!a2aPart.metadata?.[A2AMetadataKeys.THOUGHT],
  };
}

/**
 * Converts an A2A File Part to a GenAI Part.
 *
 * @param a2aPart - The A2A file part containing raw bytes or a URL.
 * @returns A GenAI part with `inlineData` or `fileData` depending on the
 *   source, with optional video metadata attached.
 * @throws {Error} If the file part contains neither bytes nor a URI.
 */
export function toGenAIPartFile(a2aPart: A2AFilePart): GenAIPart {
  const part: GenAIPart = {};
  if (a2aPart.metadata?.[A2AMetadataKeys.VIDEO_METADATA]) {
    part.videoMetadata = a2aPart.metadata[
      A2AMetadataKeys.VIDEO_METADATA
    ] as VideoMetadata;
  }

  if (a2aPart.content.$case === 'raw') {
    part.inlineData = {
      data: bytesToBase64(a2aPart.content.value),
      mimeType: a2aPart.mediaType || '',
    };
    return part;
  }

  if (a2aPart.content.$case === 'url') {
    part.fileData = {
      fileUri: a2aPart.content.value,
      mimeType: a2aPart.mediaType || '',
    };
    return part;
  }

  throw new Error(`Not a file part: ${JSON.stringify(a2aPart)}`);
}

/**
 * Converts an A2A Data Part to the appropriate GenAI Part.
 *
 * @param a2aPart - The A2A data part containing structured data and type metadata.
 * @returns A GenAI part with the appropriate function call, function response,
 *   or code execution fields, falling back to a JSON text part if the type is
 *   unrecognized.
 */
export function toGenAIPartData(a2aPart: A2ADataPart): GenAIPart {
  const value: unknown = a2aPart.content.value;
  if (value === undefined || value === null) {
    throw new Error(`No data in part: ${JSON.stringify(a2aPart)}`);
  }

  const type = a2aPart.metadata?.[A2AMetadataKeys.DATA_PART_TYPE];
  if (typeof value !== 'object' || Array.isArray(value)) {
    // A2A v1.0 data is any JSON value; only an object maps to a GenAI part.
    return {text: JSON.stringify(value)};
  }
  const data = value as Record<string, unknown>;

  if (type === DataPartType.FUNCTION_CALL) {
    return {functionCall: data};
  }

  if (type === DataPartType.FUNCTION_RESPONSE) {
    return {functionResponse: data};
  }

  if (type === DataPartType.CODE_EXECUTABLE_CODE) {
    return {executableCode: data};
  }

  if (type === DataPartType.CODE_EXEC_RESULT) {
    return {codeExecutionResult: data};
  }

  return {
    text: JSON.stringify(data),
  };
}
