/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, LlmResponse, Session} from '@google/adk';
import {
  Blob,
  CodeExecutionResult,
  Content,
  ExecutableCode,
  FileData,
  FinishReason,
  FunctionCall,
  FunctionResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  PartMediaResolution,
  VideoMetadata,
} from '@google/genai';

// The User message to replay. Either text or content will be filled in
export interface UserMessage {
  //The user message in text.
  text?: string;
  // The user message in types.Content.
  content?: Content;
  // The state changes when running this user message
  stateDelta?: Record<string, unknown>;
}

export interface TestSpec {
  // Human-readable description of what this test validates.
  description: string;
  // Name of the ADK agent to test against.
  agent: string;
  // The initial state key-value pairs in the creation_session request.
  // State could be string, numbers, objects, anything.
  initialState?: Record<string, unknown>;
  // Sequence of user messages to send to the agent during test execution.
  userMessages?: UserMessage[];
}

export interface LlmRecording {
  llmRequest?: LlmRequest;
  llmResponse?: LlmResponse;
}

export interface ToolRecording {
  toolCall?: FunctionCall;
  toolResponse?: FunctionResponse;
}

export interface Recording {
  userMessageIndex: number;
  agentName: string;

  // only one of these will be filled in
  llmRecording?: LlmRecording;
  toolRecording?: ToolRecording;
}

export interface Recordings {
  recordings: Recording[];
}

export interface TestInfo {
  name: string;
  spec: TestSpec;
  session: Session;
  recordings: Recordings;
}

// an ADK EventActions missing some filtered fields.
// Excluded is:
// - requestedAuthConfigs
// - requestedToolConfirmations
export interface FilteredEventActions {
  skipSummarization?: boolean;
  stateDelta?: {
    [key: string]: unknown;
  };
  artifactDelta: {
    [key: string]: number;
  };
  transferToAgent?: string;
  escalate?: boolean;
}

// A filtered GenAI Part missing some filtered fields
// Excluded is:
// - thought_signature
// - function_call
// - function_response
//
// Copying from the original type: Only one of these is expected to be set.
// More than one is invalid and an error.
export interface FilteredPart {
  mediaResolution?: PartMediaResolution;
  codeExecutionResult?: CodeExecutionResult;
  executableCode?: ExecutableCode;
  fileData?: FileData;
  inlineData?: Blob;
  text?: string;
  thought?: boolean;
  videoMetadata?: VideoMetadata;
}

// A filtered GenAI Content.
// Not missing any fields, just holds FilteredPart instead of Part.
export interface FilteredContent {
  parts?: FilteredPart[];
  role?: string;
}

// An ADK Event missing some filtered fields and holds a FilteredContent instead of a Content
// Excluded is:
// - id
// - timestamp
// - invocationId
// - longRunningToolIds
export interface FilteredEvent {
  // From ADK Event
  author?: string;
  branch?: string;
  actions: FilteredEventActions;

  // From ADK LlmResponse, inherited by Event
  content?: FilteredContent;
  groundingMetadata?: GroundingMetadata;
  partial?: boolean;
  turnComplete?: boolean;
  errorCode?: string;
  errorMessage?: string;
  interrupted?: boolean;
  customMetadata?: {
    [key: string]: unknown;
  };
  usageMetadata?: GenerateContentResponseUsageMetadata;
  finishReason?: FinishReason;
}
