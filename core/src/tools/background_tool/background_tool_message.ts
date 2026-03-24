/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {MessagePort, isMainThread, workerData} from 'worker_threads';

/**
 * Supported message types between main thread and worker tools.
 */
export enum BackgroundToolExecutionStatus {
  WORKER_STARTED = 'worker_started',
  WORKER_COMPLETED = 'worker_completed',
  WORKER_ERROR = 'worker_error',
  REQUIRE_INPUT = 'require_input',
  RESUME_INPUT = 'resume_input',
}

/**
 * Message payload structure.
 */
export type BackgroundToolMessage =
  | BackgroundToolWorkerStartedMessage
  | BackgroundToolWorkerCompletedMessage
  | BackgroundToolWorkerErrorMessage
  | BackgroundToolRequireInputMessage
  | BackgroundToolResumeInputMessage;

interface BaseBackgroundToolMessage {
  functionCallId: string;
  functionName?: string;
}

interface BackgroundToolWorkerStartedMessage extends BaseBackgroundToolMessage {
  type: BackgroundToolExecutionStatus.WORKER_STARTED;
  parameters?: unknown;
}

interface BackgroundToolWorkerCompletedMessage extends BaseBackgroundToolMessage {
  type: BackgroundToolExecutionStatus.WORKER_COMPLETED;
  result?: Record<string, unknown>;
}

interface BackgroundToolWorkerErrorMessage extends BaseBackgroundToolMessage {
  type: BackgroundToolExecutionStatus.WORKER_ERROR;
  error?: string;
}

interface BackgroundToolRequireInputMessage extends BaseBackgroundToolMessage {
  type: BackgroundToolExecutionStatus.REQUIRE_INPUT;
  inputRequiredMessage?: string;
}

interface BackgroundToolResumeInputMessage extends BaseBackgroundToolMessage {
  type: BackgroundToolExecutionStatus.RESUME_INPUT;
  parameters?: Record<string, unknown>;
}

export function completeBackgroundTool(
  port: MessagePort,
  result: Record<string, unknown>,
) {
  port.postMessage({
    type: BackgroundToolExecutionStatus.WORKER_COMPLETED,
    result,
  });
}

export function failBackgroundTool(port: MessagePort, error: string) {
  port.postMessage({
    type: BackgroundToolExecutionStatus.WORKER_ERROR,
    error,
  });
}

export async function getBackgroundToolParams(): Promise<unknown | undefined> {
  if (isMainThread) {
    return undefined;
  } else {
    return workerData['parameters'];
  }
}

export async function requestInputForBackgroundTool(
  port: MessagePort,
  inputRequiredMessage: string,
): Promise<unknown | undefined> {
  port.postMessage({
    type: BackgroundToolExecutionStatus.REQUIRE_INPUT,
    inputRequiredMessage,
  });

  return new Promise((resolve) => {
    const handleUserInput = (msg: BackgroundToolMessage) => {
      if (msg.type === BackgroundToolExecutionStatus.RESUME_INPUT) {
        resolve(msg.parameters);

        port.off('message', handleUserInput);
      }
    };

    port.on('message', handleUserInput);
  });
}
