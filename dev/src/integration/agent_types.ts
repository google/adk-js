/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StdioConnectionParams} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';

/**
 * Define the YAML structure interfaces. These are derived from the existing YAML files.
 */
export enum AgentClass {
  LlmAgent = 'LlmAgent',
  LoopAgent = 'LoopAgent',
  ParallelAgent = 'ParallelAgent',
  SequentialAgent = 'SequentialAgent',
}

export interface CallbackInfo {
  name: string;
}

export interface AgentReference {
  configPath: string;
}

export interface AgentToolArgs {
  agent: AgentReference;
}

export interface McpToolsetArgs {
  stdioConnectionParams: StdioConnectionParams;
  toolFilter?: string[];
}

export interface IoPart {
  text: string;
}

export interface IoParts {
  parts: IoPart[];
  role: string;
}

export interface ExampleIo {
  input: IoParts;
  output: IoParts;
}

export interface ExampleConfig {
  examples: ExampleIo[];
}

export interface ExampleToolArgs {
  examples: ExampleConfig[];
}

export interface LongRunningFunctionToolArgs {
  func: string;
}

export interface ToolsConfiguration {
  name: string;
  args?:
    | AgentToolArgs
    | McpToolsetArgs
    | ExampleToolArgs
    | LongRunningFunctionToolArgs;
}

// Main config interface
export interface YamlAgentConfig {
  agentClass: AgentClass;
  name: string;
  model: string;
  description: string;
  instruction: string;
  maxIterations?: string;
  disallowTransferToParent?: string;
  disallowTransferToPeers?: string;
  generateContentConfig?: GenerateContentConfig;
  beforeAgentCallbacks?: CallbackInfo[];
  afterAgentCallbacks?: CallbackInfo[];
  subAgents?: AgentReference[];
  tools?: ToolsConfiguration[];

  // augmented information for retrieval
  isRootAgent: boolean;
}
