/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DataPart as A2ADataPart,
  FilePart as A2AFilePart,
  Part as A2APart,
  TextPart as A2ATextPart,
  Message,
} from '@a2a-js/sdk';
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
import {A2AMetadataKeys} from './metadata_converter_utils.js';

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
  const a2aPart: A2APart = {kind: 'text', text: part.text || ''};

  if (part.thought) {
    a2aPart.metadata = {
      [A2AMetadataKeys.THOUGHT]: true,
    };
  }

  return a2aPart;
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
      kind: 'file',
      file: {
        uri: part.fileData.fileUri || '',
        mimeType: part.fileData.mimeType,
      },
      metadata,
    };
  }

  if (part.inlineData) {
    return {
      kind: 'file',
      file: {
        bytes: part.inlineData.data || '',
        mimeType: part.inlineData.mimeType,
      },
      metadata,
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
      kind: 'data',
      data: {},
      metadata: {},
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
    kind: 'data',
    data: data as unknown as Record<string, unknown>,
    metadata,
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

  return a2aMessage.role === 'user'
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
 * @throws {Error} If the A2A part has an unrecognized `kind`.
 */
export function toGenAIPart(a2aPart: A2APart): GenAIPart {
  if (a2aPart.kind === 'text') {
    return toGenAIPartText(a2aPart);
  }

  if (a2aPart.kind === 'file') {
    return toGenAIPartFile(a2aPart);
  }

  if (a2aPart.kind === 'data') {
    return toGenAIPartData(a2aPart);
  }

  throw new Error(`Unknown part kind: ${JSON.stringify(a2aPart)}`);
}

/**
 * Converts an A2A Text Part to a GenAI Part.
 *
 * @param a2aPart - The A2A text part to convert.
 * @returns A GenAI part with `text` and optional `thought` flag.
 */
export function toGenAIPartText(a2aPart: A2ATextPart): GenAIPart {
  return {
    text: a2aPart.text,
    thought: !!a2aPart.metadata?.[A2AMetadataKeys.THOUGHT],
  };
}

/**
 * Converts an A2A File Part to a GenAI Part.
 *
 * @param a2aPart - The A2A file part containing bytes or a URI.
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

  if ('bytes' in a2aPart.file) {
    part.inlineData = {
      data: a2aPart.file.bytes,
      mimeType: a2aPart.file.mimeType || '',
    };
    return part;
  }

  if ('uri' in a2aPart.file) {
    part.fileData = {
      fileUri: a2aPart.file.uri,
      mimeType: a2aPart.file.mimeType || '',
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
  if (!a2aPart.data) {
    throw new Error(`No data in part: ${JSON.stringify(a2aPart)}`);
  }

  const data = a2aPart.data as Record<string, unknown>;
  const type = a2aPart.metadata?.[A2AMetadataKeys.DATA_PART_TYPE];

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
    text: JSON.stringify(a2aPart.data),
  };
}
