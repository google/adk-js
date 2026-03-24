/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Worker} from 'worker_threads';
import {logger} from '../../utils/logger.js';
import {BaseTool, BaseToolParams, RunAsyncToolRequest} from '../base_tool.js';
import {BackgroundToolExecutionStatus} from './background_tool_message.js';
import {getInstance, WorkerCoordinator} from './worker_coordinator.js';

export const BACKGROUND_EXECUTION_PENDING_TOOL_RESULT = Symbol.for(
  'adk.tools.BackgroundExecutionPending',
);

export interface BackgroundToolParams extends BaseToolParams {
  scriptPath: string;
}

/**
 * A Background Tool runs off-thread and coordinates via IPC messages.
 */
export class BackgroundTool extends BaseTool {
  public scriptPath: string;
  private worker?: Worker;
  private coordinator: WorkerCoordinator;

  constructor(params: BackgroundToolParams) {
    // Background tools are long running by definition so they don't block the caller
    super({...params, isLongRunning: true});
    this.scriptPath = params.scriptPath;
    this.coordinator = getInstance();
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

    const workerOptions = {
      workerData: {
        args: request.args,
        functionCallId: request.toolContext.functionCallId,
      },
      execArgv,
    };

    // Note: Node 20 allows loading TS directly if --experimental-strip-types is on or import hooks exist.
    this.worker = new Worker(this.scriptPath, workerOptions);

    const callId = request.toolContext.functionCallId || 'unknown_call_id';

    this.worker.on('message', (msg) => {
      switch (msg.type) {
        case BackgroundToolExecutionStatus.WORKER_COMPLETED:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.WORKER_COMPLETED,
            functionCallId: callId,
            functionName: this.name,
            result: msg.payload,
          });
          break;
        case BackgroundToolExecutionStatus.WORKER_ERROR:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.WORKER_ERROR,
            functionCallId: callId,
            functionName: this.name,
            error: msg.payload,
          });
          break;
        case BackgroundToolExecutionStatus.REQUIRE_INPUT:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.REQUIRE_INPUT,
            functionCallId: callId,
            functionName: this.name,
            inputRequiredMessage: msg.payload,
          });
          break;
        case BackgroundToolExecutionStatus.RESUME_INPUT:
          this.coordinator.emitMessage({
            type: BackgroundToolExecutionStatus.RESUME_INPUT,
            functionCallId: callId,
            functionName: this.name,
            parameters: msg.payload,
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
          payload: msg.payload,
        });
      }
    });

    this.coordinator.emitMessage({
      type: BackgroundToolExecutionStatus.WORKER_STARTED,
      functionCallId: callId,
      functionName: this.name,
    });

    // We return immediately with the pending state
    return BACKGROUND_EXECUTION_PENDING_TOOL_RESULT;
  }
}
