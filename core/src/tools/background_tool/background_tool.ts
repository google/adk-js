/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Worker, workerData} from 'worker_threads';
import {logger} from '../../utils/logger.js';
import {BaseTool, BaseToolParams, RunAsyncToolRequest} from '../base_tool.js';
import {BackgroundToolExecutionStatus} from './background_tool_message.js';
import {getInstance, WorkerCoordinator} from './worker_coordinator.js';
import {toSchema, ToolInputParameters} from '../function_tool.js';
import {isZodObject} from '../../utils/simple_zod_to_json.js';

export const BACKGROUND_EXECUTION_PENDING_TOOL_RESULT = Symbol.for(
  'adk.tools.BackgroundExecutionPending',
);

export interface BackgroundToolParams<
  TParameters extends ToolInputParameters,
> extends BaseToolParams {
  scriptPath: string;
  parameters?: TParameters;
}

/**
 * A Background Tool runs off-thread and coordinates via IPC messages.
 */
export class BackgroundTool<
  TParameters extends ToolInputParameters,
> extends BaseTool {
  public scriptPath: string;
  private worker?: Worker;
  private coordinator: WorkerCoordinator;
  private parameters?: TParameters;

  constructor(params: BackgroundToolParams<TParameters>) {
    // Background tools are long running by definition so they don't block the caller
    super({...params, isLongRunning: true});
    this.scriptPath = params.scriptPath;
    this.coordinator = getInstance();
    this.parameters = params.parameters;
  }

  _getDeclaration() {
    return {
      name: this.name,
      description: this.description,
      parameters: toSchema(this.parameters),
    };
  }

  /**
   * Spawns the worker thread and immediately returns BackgroundExecutionPending.
   * This signals the LLM loop that this function's result will arrive later asynchronously.
   */
  async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const isTs = this.scriptPath.endsWith('.ts');

    // We try to carry over TS loaders if necessary. Often execArgv natively inherits 'tsx' or 'ts-node'.
    // Here we explicitly add a loader if the project uses them dynamically, or trust the inherritance.
    // For vitest/tsx the inheritance usually suffices, but we can pass `execArgv` if we see it lacking.
    let execArgv = process.execArgv;
    if (
      isTs &&
      !execArgv.some((arg) => arg.includes('ts-node') || arg.includes('tsx'))
    ) {
      // In testing environments or default node environments, explicitly loading a ts environment helps:
      try {
        if (typeof require !== 'undefined') {
          // If we are in CJS, maybe ts-node/register
        }
      } catch (e) {
        // Just silent fallback
      }
    }

    let validatedArgs: unknown = request.args;
    if (isZodObject(this.parameters)) {
      validatedArgs = this.parameters.parse(request.args);
    }

    const workerOptions = {
      workerData: {
        parameters: validatedArgs,
        functionName: this.name,
        functionCallId: request.toolContext.functionCallId,
      },
      execArgv,
    };

    this.worker = new Worker(this.scriptPath, workerOptions);
    const callId = request.toolContext.functionCallId || 'unknown_call_id';

    this.worker.on('message', (msg) => {
      switch (msg.type) {
        case BackgroundToolExecutionStatus.WORKER_COMPLETED:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.WORKER_COMPLETED,
            functionCallId: callId,
            functionName: this.name,
            result: msg.result,
          });
          break;
        case BackgroundToolExecutionStatus.WORKER_ERROR:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.WORKER_ERROR,
            functionCallId: callId,
            functionName: this.name,
            error: msg.error,
          });
          break;
        case BackgroundToolExecutionStatus.REQUIRE_INPUT:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.REQUIRE_INPUT,
            functionCallId: callId,
            functionName: this.name,
            inputRequiredMessage: msg.inputRequiredMessage,
          });
          break;
        case BackgroundToolExecutionStatus.RESUME_INPUT:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.RESUME_INPUT,
            functionCallId: callId,
            functionName: this.name,
            parameters: msg.parameters,
          });
          break;
        default:
          logger.error(
            `BackgroundTool [${this.name}] unknown message type`,
            msg,
          );
      }
    });

    this.worker.on('error', (err) => {
      logger.error(`BackgroundTool [${this.name}] worker failed`, err);
      this.coordinator.emitMessage({
        type: BackgroundToolExecutionStatus.WORKER_ERROR,
        functionCallId: callId,
        functionName: this.name,
        error: err.message,
      });
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        logger.error(
          `BackgroundTool [${this.name}] worker stopped with exit code ${code}`,
        );
      }
    });

    // Listen for resume input from main thread to send back to worker.
    this.coordinator.on(BackgroundToolExecutionStatus.RESUME_INPUT, (msg) => {
      if (msg.functionCallId === callId) {
        this.worker?.postMessage({
          type: BackgroundToolExecutionStatus.RESUME_INPUT,
          parameters: msg.parameters,
        });
      }
    });

    this.coordinator.emitMessage({
      type: BackgroundToolExecutionStatus.WORKER_STARTED,
      functionCallId: callId,
      functionName: this.name,
      parameters: validatedArgs,
    });

    // We return immediately with the pending state
    return BACKGROUND_EXECUTION_PENDING_TOOL_RESULT;
  }
}
