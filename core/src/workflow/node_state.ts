/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * Represents the execution status of a node in a workflow graph or dynamic chain.
 */
export enum NodeStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  PAUSED_HITL = 'PAUSED_HITL',
  FAILED = 'FAILED',
}

/**
 * Checkpointed state for a specific node execution.
 * Stored inside `InvocationContext.agentStates[executionId]`.
 */
export interface NodeState<TInput = unknown, TOutput = unknown> {
  /**
   * The deterministic execution ID assigned to this node execution.
   */
  executionId: string;

  /**
   * The canonical name of the node.
   */
  nodeName: string;

  /**
   * The current status of the node execution.
   */
  status: NodeStatus;

  /**
   * The input payload passed into the node during execution.
   */
  inputPayload?: TInput;

  /**
   * The final output payload yielded or returned by the node upon completion.
   */
  outputPayload?: TOutput;

  /**
   * Error message if the node execution failed (`status === FAILED`).
   */
  errorMessage?: string;

  /**
   * Timestamp in milliseconds when this state record was last updated.
   */
  timestamp: number;

  /**
   * Events emitted by the node during live execution, cached for replaying on resumption.
   */
  cachedEvents?: Event[];

  /**
   * Indicates if this node previously paused for Human-in-the-Loop (`RequestInput`).
   */
  wasPausedHitl?: boolean;

  /**
   * Stores intermediate or final payload before completion status transition.
   */
  lastOutputPayload?: unknown;
}

/**
 * Type guard to check if an object is a valid NodeState instance.
 * @param obj The object to check.
 * @returns True if the object matches the NodeState structure.
 */
export function isNodeState(obj: unknown): obj is NodeState {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'executionId' in obj &&
    typeof (obj as NodeState).executionId === 'string' &&
    'nodeName' in obj &&
    typeof (obj as NodeState).nodeName === 'string' &&
    'status' in obj &&
    Object.values(NodeStatus).includes((obj as NodeState).status)
  );
}
