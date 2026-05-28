/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {Language} from '@google-cloud/vertexai/build/src/genai/types.js';
import {experimental} from '../utils/experimental.js';
import {guessMimeType} from '../utils/file_utils.js';

interface LocalChunk {
  data?: string;
  mimeType?: string;
  metadata?: {
    attributes?: Record<string, string>;
  };
}

const SANDBOX_PATTERN =
  /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)\/sandboxEnvironments\/(\d+)$/;
const ENGINE_PATTERN =
  /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;

import {InvocationContext} from '../agents/invocation_context.js';
import {logger} from '../utils/logger.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  File,
} from './code_execution_utils.js';

const DEFAULT_MAX_ATTEMPTS = 180;
const DEFAULT_SANDBOX_TTL = '31536000s';
const DEFAULT_SANDBOX_DISPLAY_NAME = 'default_sandbox';
const DEFAULT_ENGINE_DISPLAY_NAME = 'default_engine';

/**
 * Options for AgentEngineSandboxCodeExecutor.
 */
export interface AgentEngineSandboxCodeExecutorOptions {
  /**
   * If set, load the existing resource name of the code execution sandbox.
   * Format: projects/123/locations/us-central1/reasoningEngines/456/sandboxEnvironments/789
   */
  sandboxResourceName?: string;

  /**
   * The resource name of the agent engine to use to create the code execution sandbox.
   * Format: projects/123/locations/us-central1/reasoningEngines/456
   */
  agentEngineResourceName?: string;

  /**
   * Project ID to use. If not provided, read from GOOGLE_CLOUD_PROJECT env var.
   */
  projectId?: string;

  /**
   * Location to use. If not provided, read from GOOGLE_CLOUD_LOCATION env var or default to 'us-central1'.
   */
  location?: string;

  /**
   * Optional client instance to use. If not provided, a new one will be created.
   * Primarily for testing.
   */
  client?: Client;
}

/**
 * A code executor that uses Agent Engine Code Execution Sandbox to execute code.
 */
function mapLanguage(lang: CodeExecutionLanguage): Language {
  switch (lang) {
    case CodeExecutionLanguage.PYTHON:
      return Language.LANGUAGE_PYTHON;
    case CodeExecutionLanguage.JAVASCRIPT:
      return Language.LANGUAGE_JAVASCRIPT;
    default:
      throw new Error(`Unsupported language for Agent Engine Sandbox: ${lang}`);
  }
}

/**
 * A code executor that uses Agent Engine Code Execution Sandbox to execute code.
 */
@experimental
export class AgentEngineSandboxCodeExecutor extends BaseCodeExecutor {
  sandboxResourceName?: string;
  agentEngineResourceName?: string;
  private projectId?: string;
  private location?: string;
  private client: Client;
  private agentEngineCreationPromise?: Promise<string>;

  constructor(options: AgentEngineSandboxCodeExecutorOptions = {}) {
    super();
    this.sandboxResourceName = options.sandboxResourceName;
    this.agentEngineResourceName = options.agentEngineResourceName;
    this.projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
    this.location =
      options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    if (this.sandboxResourceName) {
      const match = this.sandboxResourceName.match(SANDBOX_PATTERN);
      if (match) {
        this.projectId = match[1];
        this.location = match[2];
      } else {
        throw new Error(
          `Invalid sandbox resource name: ${this.sandboxResourceName}`,
        );
      }
    } else if (this.agentEngineResourceName) {
      const match = this.agentEngineResourceName.match(ENGINE_PATTERN);
      if (match) {
        this.projectId = match[1];
        this.location = match[2];
      } else {
        throw new Error(
          `Invalid agent engine resource name: ${this.agentEngineResourceName}`,
        );
      }
    }

    if (options.client) {
      this.client = options.client;
    } else {
      if (!this.projectId) {
        throw new Error('Project ID is required.');
      }
      this.client = new Client({
        project: this.projectId,
        location: this.location,
      });
    }
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {invocationContext, codeExecutionInput} = params;

    const language = mapLanguage(codeExecutionInput.language);

    const agentEngineName = await this.getOrCreateAgentEngine();
    const sandboxName = await this.getOrCreateSandbox(
      invocationContext,
      agentEngineName,
      language,
    );

    const inputs: LocalChunk[] = [
      {
        mimeType: 'application/json',
        data: Buffer.from(
          JSON.stringify({code: codeExecutionInput.code}),
        ).toString('base64'),
      },
    ];

    if (codeExecutionInput.inputFiles) {
      for (const file of codeExecutionInput.inputFiles) {
        inputs.push({
          mimeType: file.mimeType,
          data: file.content, // Assumed to be already base64 encoded based on CodeExecutionInput definition
          metadata: {
            attributes: {
              file_name: Buffer.from(file.name).toString('base64'),
            },
          },
        });
      }
    }

    logger.debug(`Executing code in sandbox ${sandboxName}...`);
    const response =
      await this.client.agentEnginesInternal.sandboxes.executeCodeInternal({
        name: sandboxName,
        inputs: inputs,
      });

    let stdout = '';
    let stderr = '';
    const outputFiles: File[] = [];

    if (response.outputs) {
      for (const output of response.outputs) {
        const attributes = output.metadata?.attributes || {};
        const encodedFileName = attributes['file_name'];
        const fileName = encodedFileName
          ? Buffer.from(encodedFileName, 'base64').toString('utf-8')
          : undefined;

        if (output.mimeType === 'application/json' && !fileName) {
          if (output.data) {
            const jsonStr = Buffer.from(output.data, 'base64').toString(
              'utf-8',
            );
            try {
              const jsonData = JSON.parse(jsonStr);
              if (jsonData.msg_out !== undefined) {
                stdout = jsonData.msg_out;
              } else {
                stdout = '';
              }
              if (jsonData.msg_err !== undefined) {
                stderr = jsonData.msg_err;
              } else {
                stderr = '';
              }
            } catch (e) {
              logger.warn('Failed to parse JSON output from sandbox', e);
              stdout = jsonStr;
            }
          }
        } else {
          let mimeType = output.mimeType;
          const name = fileName || 'output_file';
          if (!mimeType) {
            mimeType = guessMimeType(name);
          }
          outputFiles.push({
            name: name,
            content: output.data || '',
            mimeType: mimeType,
          });
        }
      }
    }

    return {
      stdout,
      stderr,
      outputFiles,
    };
  }

  private async getOrCreateAgentEngine(): Promise<string> {
    if (this.agentEngineResourceName) {
      return this.agentEngineResourceName;
    }

    if (!this.agentEngineCreationPromise) {
      this.agentEngineCreationPromise = (async () => {
        logger.debug(
          'No Agent Engine resource name provided. Creating a new one...',
        );
        const operation = await this.client.agentEnginesInternal.createInternal(
          {
            config: {
              displayName: DEFAULT_ENGINE_DISPLAY_NAME,
            },
          },
        );

        let apiResponse = operation;
        let attempts = 0;
        while (!apiResponse.done && attempts < DEFAULT_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          apiResponse =
            await this.client.agentEnginesInternal.getAgentOperationInternal({
              operationName: operation.name!,
            });
          attempts++;
        }

        if (!apiResponse.done) {
          throw new Error(
            `Agent Engine creation operation ${operation.name} did not complete in time.`,
          );
        }

        const response = apiResponse.response as {name?: string};
        this.agentEngineResourceName = response.name;
        logger.debug(`Created Agent Engine: ${this.agentEngineResourceName}`);
        return this.agentEngineResourceName!;
      })();
    }

    return this.agentEngineCreationPromise;
  }

  private async getOrCreateSandbox(
    invocationContext: InvocationContext,
    agentEngineName: string,
    language: Language,
  ): Promise<string> {
    if (this.sandboxResourceName) {
      return this.sandboxResourceName;
    }

    // Try to get from session state with language-specific key
    const stateKey = `sandbox_name_${language.toLowerCase()}`;
    let sandboxName = invocationContext.session?.state?.[stateKey] as
      | string
      | undefined;
    let createNewSandbox = false;

    if (!sandboxName) {
      createNewSandbox = true;
    } else {
      try {
        const sandbox =
          await this.client.agentEnginesInternal.sandboxes.getInternal({
            name: sandboxName,
          });
        if (!sandbox || sandbox.state !== 'STATE_RUNNING') {
          createNewSandbox = true;
        }
      } catch (error) {
        logger.debug(
          `Failed to get sandbox ${sandboxName}, will create a new one`,
          error,
        );
        createNewSandbox = true;
      }
    }

    if (createNewSandbox) {
      logger.debug(`Creating a new ${language} code execution sandbox...`);
      const operation =
        await this.client.agentEnginesInternal.sandboxes.createInternal({
          name: agentEngineName,
          spec: {
            codeExecutionEnvironment: {
              codeLanguage: language,
            },
          },
          config: {
            displayName: DEFAULT_SANDBOX_DISPLAY_NAME,
            ttl: DEFAULT_SANDBOX_TTL,
          },
        });

      let apiResponse = operation;
      let attempts = 0;
      while (!apiResponse.done && attempts < DEFAULT_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        apiResponse =
          await this.client.agentEnginesInternal.sandboxes.getSandboxOperationInternal(
            {
              operationName: operation.name!,
            },
          );
        attempts++;
      }

      if (!apiResponse.done) {
        throw new Error(
          `Sandbox creation operation ${operation.name} did not complete in time.`,
        );
      }

      const response = apiResponse.response as {name?: string};
      sandboxName = response.name!;

      if (invocationContext.session) {
        if (!invocationContext.session.state) {
          invocationContext.session.state = {};
        }
        invocationContext.session.state[stateKey] = sandboxName;
      }
    }

    return sandboxName!;
  }
}
