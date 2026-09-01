/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning a paused run into something a person can answer.
 *
 * ADK carries a pause in a `functionCall` part rather than in text, so a client
 * that renders only text shows the user nothing and the bot appears to hang.
 * This maps those into a readable prompt and, where the channel has them,
 * buttons — and maps the answer back into the `functionResponse` that resumes
 * the run.
 */

import {
  getUserInputRequests,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  type Event,
  type UserInputKind,
} from '@google/adk';
import type {Part} from '@google/genai';

import type {ChannelCapabilities, OutboundAction} from '../types.js';

/** One thing a run is waiting for, with what we need to render it. */
export interface GatewayInterrupt {
  kind: UserInputKind;
  interruptId: string;
  functionCallName: string;
  /** The prompt the raiser supplied, if it is fit to show a person. */
  message?: string;
  /** The tool awaiting approval, for a confirmation. */
  toolName?: string;
  /** The arguments that tool was called with, so the prompt can be concrete. */
  toolArgs?: Record<string, unknown>;
  /** The schema a reply should satisfy, when one was declared. */
  responseSchema?: unknown;
}

/**
 * ADK's stock confirmation hint is written for whoever is building the client,
 * not for the person in the chat: *"...by responding with a FunctionResponse
 * with an expected ToolConfirmation payload."* Shipping that to an end user is
 * a bug, so it is detected and replaced with a sentence about the actual tool.
 */
const INTERNAL_HINT =
  /responding with a FunctionResponse|ToolConfirmation payload/i;

/** Everything an event is waiting on. */
export function interruptsIn(event: Event): GatewayInterrupt[] {
  const enriched = originalCallArgs(event);

  return getUserInputRequests(event).map((request) => ({
    kind: request.kind,
    interruptId: request.interruptId,
    functionCallName: request.functionCallName,
    message:
      request.message && !INTERNAL_HINT.test(request.message)
        ? request.message
        : undefined,
    toolName: request.toolName,
    toolArgs: enriched.get(request.interruptId),
    responseSchema: request.responseSchema,
  }));
}

/** What to show the user. */
export function promptFor(interrupt: GatewayInterrupt): string {
  switch (interrupt.kind) {
    case 'confirmation':
      return interrupt.message ?? describeToolCall(interrupt);
    case 'input':
      return interrupt.message ?? 'What would you like to do?';
    case 'credential':
      return (
        interrupt.message ?? 'This needs you to sign in before it can continue.'
      );
    default:
      return 'Waiting for your reply.';
  }
}

/**
 * The buttons to offer, or none when the channel has no buttons and the user
 * should answer in words instead.
 */
export function actionsFor(
  interrupt: GatewayInterrupt,
  capabilities: ChannelCapabilities,
): OutboundAction[] {
  if (capabilities.buttons === 'none') {
    return [];
  }

  switch (interrupt.kind) {
    case 'confirmation':
      return [
        {
          label: '✅ Approve',
          payload: answerOf(interrupt, true),
          style: 'primary',
        },
        {
          label: '❌ Reject',
          payload: answerOf(interrupt, false),
          style: 'danger',
        },
      ];

    case 'input': {
      // A closed set of choices renders as buttons; free text cannot.
      const choices = enumChoices(interrupt.responseSchema);
      return choices.map((choice) => ({
        label: String(choice),
        payload: answerOf(interrupt, choice),
      }));
    }

    default:
      return [];
  }
}

/** How a user should answer when there are no buttons. */
export function plainTextHint(interrupt: GatewayInterrupt): string | undefined {
  return interrupt.kind === 'confirmation' ? 'Reply *yes* or *no*.' : undefined;
}

/** The answer a button carries. */
export interface InterruptAnswer {
  interruptId: string;
  functionCallName: string;
  value: unknown;
}

function answerOf(
  interrupt: GatewayInterrupt,
  value: unknown,
): InterruptAnswer {
  return {
    interruptId: interrupt.interruptId,
    functionCallName: interrupt.functionCallName,
    value,
  };
}

/**
 * Builds the `functionResponse` that resumes a run.
 *
 * A confirmation takes `{confirmed}`; everything else is wrapped as `{result}`,
 * the envelope `RequestInput` documents and unwraps.
 */
export function answerPart(answer: InterruptAnswer): Part {
  const response =
    answer.functionCallName === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME
      ? {confirmed: answer.value === true}
      : {result: answer.value};

  return {
    functionResponse: {
      id: answer.interruptId,
      name: answer.functionCallName,
      response,
    },
  };
}

/** Whether a payload looks like an interrupt answer. */
export function isInterruptAnswer(value: unknown): value is InterruptAnswer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<InterruptAnswer>;
  return (
    typeof candidate.interruptId === 'string' &&
    typeof candidate.functionCallName === 'string'
  );
}

/** A human sentence for a tool call, used when the hint is unusable. */
function describeToolCall(interrupt: GatewayInterrupt): string {
  const name = interrupt.toolName ?? 'this action';
  const args = formatArgs(interrupt.toolArgs);
  return args ? `Run **${name}**?\n\n${args}` : `Run **${name}**?`;
}

function formatArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args || Object.keys(args).length === 0) {
    return undefined;
  }
  return Object.entries(args)
    .map(([key, value]) => `• ${key}: ${format(value)}`)
    .join('\n');
}

function format(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The arguments of the call each confirmation is gating.
 *
 * `getUserInputRequests` reports the tool's name but not what it was called
 * with, and the arguments are what make the prompt worth reading — "delete
 * order 4711" rather than "run delete_order".
 */
function originalCallArgs(event: Event): Map<string, Record<string, unknown>> {
  const byInterruptId = new Map<string, Record<string, unknown>>();

  for (const part of event.content?.parts ?? []) {
    const call = part.functionCall;
    if (call?.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME || !call.id) {
      continue;
    }
    const original = (call.args as Record<string, unknown> | undefined)?.[
      'originalFunctionCall'
    ] as {args?: Record<string, unknown>} | undefined;
    if (original?.args) {
      byInterruptId.set(call.id, original.args);
    }
  }

  return byInterruptId;
}

/** The allowed values of an enum schema, if it is one. */
function enumChoices(schema: unknown): unknown[] {
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }
  const candidate = schema as {enum?: unknown};
  return Array.isArray(candidate.enum) && candidate.enum.length <= 8
    ? candidate.enum
    : [];
}

/** Re-exported so callers can name the framework call they are answering. */
export {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
};
