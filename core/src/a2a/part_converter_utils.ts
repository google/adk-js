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
  CodeExecutionResult as GenAICodeExecutionResult,
  Content as GenAIContent,
  ExecutableCode as GenAIExecutableCode,
  FunctionCall as GenAIFunctionCall,
  FunctionResponse as GenAIFunctionResponse,
  Part as GenAIPart,
  createModelContent,
  createUserContent,
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
 * Converts GenAI Parts to A2A Parts.
 */
export function toA2AParts(
  parts: GenAIPart[] = [],
  longRunningToolIDs: string[] = [],
): A2APart[] {
  return parts.map((part) => toA2APart(part, longRunningToolIDs));
}

/**
 * Converts a GenAI Part to an A2A Part.
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
 */
export function toA2AFilePart(part: GenAIPart): A2APart {
  if (part.fileData) {
    return {
      kind: 'file',
      file: {
        uri: part.fileData.fileUri || '',
        mimeType: part.fileData.mimeType,
      },
      metadata: {},
    };
  }

  if (part.inlineData) {
    return {
      kind: 'file',
      file: {
        bytes: part.inlineData.data || '',
        mimeType: part.inlineData.mimeType,
      },
      metadata: {},
    };
  }

  throw new Error(`Not a file part: ${JSON.stringify(part)}`);
}

/**
 * Converts a GenAI Data Part to an A2A Data Part.
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
    throw new Error(`Unknown part type: ${JSON.stringify(part)}`);
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

export function toGenAIContent(a2aMessage: Message): GenAIContent {
  const parts = toGenAIParts(a2aMessage.parts);

  return a2aMessage.role === 'user'
    ? createUserContent(parts)
    : createModelContent(parts);
}

/**
 * Converts an A2A Part to a GenAI Part.
 */
export function toGenAIParts(a2aParts: A2APart[]): GenAIPart[] {
  return a2aParts.map((a2aPart) => toGenAIPart(a2aPart));
}

/**
 * Converts an A2A Part to a GenAI Part.
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
 */
export function toGenAIPartText(a2aPart: A2ATextPart): GenAIPart {
  return {
    text: a2aPart.text,
    thought: !!a2aPart.metadata?.[A2AMetadataKeys.THOUGHT],
  };
}

/**
 * Converts an A2A File Part to a GenAI Part.
 */
export function toGenAIPartFile(a2aPart: A2AFilePart): GenAIPart {
  if ('bytes' in a2aPart.file) {
    return {
      inlineData: {
        data: a2aPart.file.bytes,
        mimeType: a2aPart.file.mimeType || '',
      },
    };
  }

  if ('uri' in a2aPart.file) {
    return {
      fileData: {
        fileUri: a2aPart.file.uri,
        mimeType: a2aPart.file.mimeType || '',
      },
    };
  }

  throw new Error(`Not a file part: ${JSON.stringify(a2aPart)}`);
}

/**
 * Converts an A2A Data Part to a GenAI Part.
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
