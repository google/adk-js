/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Attributes} from '@opentelemetry/api';

import type {BaseAgent} from '../../../../agents/base_agent.js';
import {GenAiAttr} from '../common/attributes.js';

/** Parameters for {@link buildAgentInvocationAttributes}. */
export interface AgentInvocationAttributesParams {
  readonly agent: BaseAgent;
  readonly sessionId: string | undefined;
}

/** Builds the attributes of an `invoke_agent` span. */
export function buildAgentInvocationAttributes({
  agent,
  sessionId,
}: AgentInvocationAttributesParams): Attributes {
  return {
    [GenAiAttr.OPERATION_NAME]: 'invoke_agent',
    [GenAiAttr.AGENT_DESCRIPTION]: agent.description,
    [GenAiAttr.AGENT_NAME]: agent.name,
    ...(sessionId === undefined
      ? {}
      : {[GenAiAttr.CONVERSATION_ID]: sessionId}),
  };
}
