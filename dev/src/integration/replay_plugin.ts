/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Recording} from './test_types.js';

export class ReplayPlugin extends BasePlugin {
  constructor(
    private recordings: Recording[],
    private context: {userMessageIndex: number},
  ) {
    super('replay-plugin');
  }

  override async beforeModelCallback({
    callbackContext,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const agentName = callbackContext.agentName;
    const index = this.recordings.findIndex(
      (r) =>
        r.userMessageIndex === this.context.userMessageIndex &&
        r.agentName === agentName &&
        r.llmRecording?.llmResponse &&
        // replay internal flag to mark event as consumed
        !(r as unknown as {_consumed: boolean})._consumed,
    );

    if (index === -1) {
      throw new Error(
        `No LLM recording found for agent ${agentName} at turn ${this.context.userMessageIndex}`,
      );
    }

    const rec = this.recordings[index];
    (rec as unknown as {_consumed: boolean})._consumed = true;

    return rec.llmRecording!.llmResponse!;
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const agentName = params.toolContext.invocationContext.agent.name;
    const toolName = params.tool.name;

    const index = this.recordings.findIndex(
      (r) =>
        r.userMessageIndex === this.context.userMessageIndex &&
        r.agentName === agentName &&
        r.toolRecording?.toolCall?.name === toolName &&
        !(r as unknown as {_consumed: boolean})._consumed,
    );

    if (index === -1) {
      throw new Error(
        `No tool recording found for agent ${agentName}, tool ${toolName} at turn ${this.context.userMessageIndex}`,
      );
    }

    const rec = this.recordings[index];
    (rec as unknown as {_consumed: boolean})._consumed = true;

    // Returning the recorded response short-circuits the real tool call, so
    // built-in tools whose only observable effect is on EventActions must have
    // that effect replicated here. (adk-python instead runs the real tool in
    // its replay plugin before returning the recording.)
    switch (toolName) {
      case 'transfer_to_agent':
        params.toolContext.actions.transferToAgent = params.toolArgs[
          'agentName'
        ] as string;
        break;
      case 'exit_loop':
        params.toolContext.actions.escalate = true;
        params.toolContext.actions.skipSummarization = true;
        break;
    }

    // The response from a tool call is a plain object.
    const response = rec.toolRecording!.toolResponse!.response;
    if (response instanceof Map) {
      return Object.fromEntries(response);
    }
    return response;
  }
}
