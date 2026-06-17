/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';

import {Context} from '../agents/context.js';
import {Event} from '../events/event.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {BaseTool} from '../tools/base_tool.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';

// Constants
export const REQUEST_CONFIRMATION_FUNCTION_CALL_NAME =
  'adk_request_confirmation';

const TOOL_CALL_SECURITY_CHECK_STATES = 'orcas_tool_call_security_check_states';
const INTERMEDIATE_REQUIRE_TOOL_CALL_CONFIRMATION_ERROR =
  'This tool call needs external confirmation before completion.';

// --------------------------------------------------------------------------
// #START Policy Engine Interface
// --------------------------------------------------------------------------

/**
 * The outcome of a policy check.
 */
export enum PolicyOutcome {
  // The tool call is rejected by the policy engine.
  DENY = 'DENY',
  // The tool call needs external confirmation before proceeding.
  CONFIRM = 'CONFIRM',
  // The tool call is allowed by the policy engine.
  ALLOW = 'ALLOW',
}

/** The result returned by a policy engine after evaluating a tool call. */
export interface PolicyCheckResult {
  /** The policy decision: `ALLOW`, `DENY`, or `CONFIRM`. */
  outcome: string;
  /** Optional human-readable explanation of the decision. */
  reason?: string;
}

/** Context passed to a policy engine when evaluating a tool call. */
export interface ToolCallPolicyContext {
  /** The tool being invoked. */
  tool: BaseTool;
  /** The arguments supplied to the tool call. */
  toolArgs: Record<string, unknown>;
}

/** Interface for policy engines that gate tool call execution. */
export interface BasePolicyEngine {
  /**
   * Evaluates whether a tool call should be allowed, denied, or confirmed.
   *
   * @param context - The tool and its arguments to evaluate.
   * @returns A promise resolving to the policy decision.
   */
  evaluate(context: ToolCallPolicyContext): Promise<PolicyCheckResult>;
}

/** In-memory policy engine that permits all tool calls. Intended for prototyping. */
export class InMemoryPolicyEngine implements BasePolicyEngine {
  /**
   * Always returns {@link PolicyOutcome.ALLOW} for every tool call.
   *
   * @returns A promise resolving to an ALLOW result.
   */
  async evaluate(): Promise<PolicyCheckResult> {
    // Default permissive implementation
    return Promise.resolve({
      outcome: PolicyOutcome.ALLOW,
      reason: 'For prototyping purpose, all tool calls are allowed.',
    });
  }
}
// --------------------------------------------------------------------------
// #END Policy Engine Interface
// --------------------------------------------------------------------------

/**
 *  Security Plugin for running Orcas agents.
 */
export class SecurityPlugin extends BasePlugin {
  private readonly policyEngine: BasePolicyEngine;

  /**
   * @param params - Optional configuration. Defaults to {@link InMemoryPolicyEngine}
   *   when no policy engine is provided.
   */
  constructor(params?: {policyEngine?: BasePolicyEngine}) {
    super('security_plugin');
    this.policyEngine = params?.policyEngine ?? new InMemoryPolicyEngine();
  }

  /**
   * Intercepts tool calls, evaluating them against the policy engine before
   * execution and handling confirmation flows for calls that require it.
   *
   * @returns A partial or error response object if the call is blocked or
   *   awaiting confirmation, or `undefined` to allow execution to proceed.
   */
  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: {[key: string]: unknown};
    toolContext: Context;
  }): Promise<{[key: string]: unknown} | undefined> {
    const toolCallCheckState = this.getToolCallCheckState(toolContext);

    // We only check the tool call policy ONCE, when the tool call is handled
    // for the first time.
    if (!toolCallCheckState) {
      return this.checkToolCallPolicy({
        tool: tool,
        toolArgs: toolArgs,
        toolContext: toolContext,
      });
    }

    if (toolCallCheckState !== PolicyOutcome.CONFIRM) {
      return;
    }

    if (!toolContext.toolConfirmation) {
      return {partial: INTERMEDIATE_REQUIRE_TOOL_CALL_CONFIRMATION_ERROR};
    }

    this.setToolCallCheckState(toolContext, toolContext.toolConfirmation);
    if (!toolContext.toolConfirmation.confirmed) {
      return {
        error: 'Tool call rejected from confirmation flow.',
      };
    }
    toolContext.toolConfirmation = undefined;
    return;
  }

  private getToolCallCheckState(
    toolContext: Context,
  ): string | ToolConfirmation | undefined {
    const {functionCallId} = toolContext;
    if (!functionCallId) {
      return;
    }

    const toolCallStates =
      (toolContext.state.get(TOOL_CALL_SECURITY_CHECK_STATES) as {
        [key: string]: string | ToolConfirmation;
      }) ?? {};
    return toolCallStates[functionCallId];
  }

  private setToolCallCheckState(
    toolContext: Context,
    state: string | ToolConfirmation,
  ): void {
    const {functionCallId} = toolContext;
    if (!functionCallId) {
      return;
    }

    const toolCallStates =
      (toolContext.state.get(TOOL_CALL_SECURITY_CHECK_STATES) as {
        [key: string]: string | ToolConfirmation;
      }) ?? {};
    toolCallStates[functionCallId] = state;
    toolContext.state.set(TOOL_CALL_SECURITY_CHECK_STATES, toolCallStates);
  }

  private async checkToolCallPolicy({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: {[key: string]: unknown};
    toolContext: Context;
  }): Promise<{[key: string]: unknown} | undefined> {
    const policyCheckResult = await this.policyEngine.evaluate({
      tool,
      toolArgs,
    });

    this.setToolCallCheckState(toolContext, policyCheckResult.outcome);

    switch (policyCheckResult.outcome) {
      case PolicyOutcome.DENY:
        return {
          error: `This tool call is rejected by policy engine. Reason: ${
            policyCheckResult.reason
          }`,
        };
      case PolicyOutcome.CONFIRM:
        toolContext.requestConfirmation({
          hint: `Policy engine requires confirmation calling tool: ${
            tool.name
          }. Reason: ${policyCheckResult.reason}`,
        });
        return {partial: INTERMEDIATE_REQUIRE_TOOL_CALL_CONFIRMATION_ERROR};
      case PolicyOutcome.ALLOW:
        return;
      default:
        return;
    }
  }
}

/**
 * Gets the ask user confirmation function calls from the event.
 * @param event The event to get the function calls from.
 * @returns The ask user confirmation function calls.
 */
export function getAskUserConfirmationFunctionCalls(
  event: Event,
): FunctionCall[] {
  if (!event.content || !event.content.parts) {
    return [];
  }
  const results: FunctionCall[] = [];

  for (const part of event.content.parts) {
    if (
      part &&
      part.functionCall &&
      part.functionCall.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME
    ) {
      results.push(part.functionCall);
    }
  }
  return results;
}
