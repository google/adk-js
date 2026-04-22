/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {
  Chunk,
  CreateAgentEngineRequestParameters,
  ReasoningEngine,
  SandboxEnvironment,
} from '@google-cloud/vertexai/build/src/genai/types.js';

import {InvocationContext} from '../agents/invocation_context.js';
import {logger} from '../utils/logger.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult, File} from './code_execution_utils.js';

const DEFAULT_MAX_ATTEMPTS = 30;

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

    const sandboxPattern =
      /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)\/sandboxEnvironments\/(\d+)$/;
    const enginePattern =
      /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;

    if (this.sandboxResourceName) {
      const match = this.sandboxResourceName.match(sandboxPattern);
      if (match) {
        this.projectId = match[1];
        this.location = match[2];
      } else {
        throw new Error(
          `Invalid sandbox resource name: ${this.sandboxResourceName}`,
        );
      }
    } else if (this.agentEngineResourceName) {
      const match = this.agentEngineResourceName.match(enginePattern);
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

    const agentEngineName = await this.getOrCreateAgentEngine();
    const sandboxName = await this.getOrCreateSandbox(
      invocationContext,
      agentEngineName,
    );

    const inputs: Chunk[] = [
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
        const fileName = attributes['file_name'];

        if (output.mimeType === 'application/json' && !fileName) {
          if (output.data) {
            const jsonStr = Buffer.from(output.data, 'base64').toString(
              'utf-8',
            );
            try {
              const jsonData = JSON.parse(jsonStr);
              stdout = jsonData.msg_out || '';
              stderr = jsonData.msg_err || '';
            } catch (e) {
              logger.warn('Failed to parse JSON output from sandbox', e);
              stdout = jsonStr;
            }
          }
        } else {
          let mimeType = output.mimeType;
          const name = fileName || 'output_file';
          if (!mimeType && name) {
            const ext = name.split('.').pop();
            if (ext === 'csv') mimeType = 'text/csv';
            else if (ext === 'png') mimeType = 'image/png';
            else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
            else mimeType = 'application/octet-stream';
          }
          outputFiles.push({
            name: name,
            content: output.data || '',
            mimeType: mimeType || 'application/octet-stream',
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
        logger.info(
          'No Agent Engine resource name provided. Creating a new one...',
        );
        const operation = await this.client.agentEnginesInternal.createInternal(
          {
            config: {
              displayName: 'default_engine',
            },
          } as CreateAgentEngineRequestParameters,
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

        const response = apiResponse.response as ReasoningEngine;
        this.agentEngineResourceName = response.name;
        logger.info(`Created Agent Engine: ${this.agentEngineResourceName}`);
        return this.agentEngineResourceName!;
      })();
    }

    return this.agentEngineCreationPromise;
  }

  private async getOrCreateSandbox(
    invocationContext: InvocationContext,
    agentEngineName: string,
  ): Promise<string> {
    if (this.sandboxResourceName) {
      return this.sandboxResourceName;
    }

    // Try to get from session state
    let sandboxName = invocationContext.session?.state?.['sandbox_name'] as
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
      logger.info('Creating a new code execution sandbox...');
      const operation =
        await this.client.agentEnginesInternal.sandboxes.createInternal({
          name: agentEngineName,
          spec: {
            codeExecutionEnvironment: {},
          },
          config: {
            displayName: 'default_sandbox',
            ttl: '31536000s', // 1 year
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

      const response = apiResponse.response as SandboxEnvironment;
      sandboxName = response.name!;

      if (invocationContext.session) {
        if (!invocationContext.session.state) {
          invocationContext.session.state = {};
        }
        invocationContext.session.state['sandbox_name'] = sandboxName;
      }
    }

    return sandboxName!;
  }
}
