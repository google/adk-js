/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {ToolConfirmation} from '../../tools/tool_confirmation.js';
import {isSegmentPrefix} from '../../utils/branch_trie.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  handleFunctionCallList,
} from '../functions.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/** A pinned tool call an approval unlocked, with the decision it carries. */
interface ResumableCall {
  /** The pinned call to execute, exactly as it was presented for approval. */
  call: FunctionCall;
  /** The user's decision. */
  confirmation: ToolConfirmation;
}

/**
 * Resumes tool calls that were paused for user confirmation. Scans the session
 * event history for pending confirmation responses and re-invokes the
 * corresponding tools before the next LLM turn.
 */
export class RequestConfirmationLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Resumes tool calls that were paused for user confirmation, re-invoking
   * them with the confirmed or denied decision before the next LLM turn.
   *
   * @param invocationContext - The current invocation context, including the
   *   session event history used to locate pending confirmation responses.
   * @yields Function response events for tools that have been confirmed and
   *   are ready to resume.
   */
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }
    const events = eventsInScope(invocationContext);
    if (events.length === 0) {
      return;
    }

    // Step 1: read the decisions out of the user's latest turn.
    const approvals = collectApprovals(
      events,
      invocationContext.runConfig?.plainTextToolConfirmation ?? false,
    );
    if (approvals.size === 0) {
      return;
    }

    // Step 2: map each decision back to the action it approves, dropping any
    // approval that has already been acted on.
    const resumable = resolveResumableCalls(events, approvals);
    if (resumable.size === 0) {
      return;
    }

    // Step 3: run the pinned actions.
    const toolsList = await agent.canonicalTools(
      new ReadonlyContext(invocationContext),
    );
    const toolsDict = Object.fromEntries(
      toolsList.map((tool) => [tool.name, tool]),
    );

    const functionResponseEvent = await handleFunctionCallList({
      invocationContext,
      functionCalls: [...resumable.values()].map((entry) => entry.call),
      toolsDict,
      beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
      afterToolCallbacks: agent.canonicalAfterToolCallbacks,
      filters: new Set(resumable.keys()),
      toolConfirmationDict: Object.fromEntries(
        [...resumable].map(([id, entry]) => [id, entry.confirmation]),
      ),
    });

    if (!functionResponseEvent) {
      return;
    }

    // Put the response in the in-memory session before yielding it. The
    // content builder runs immediately behind this processor in the same
    // step and reads `session.events`, while a yielded event only reaches
    // the runner — which is what durably appends it — once the step is
    // done. Without this the model is rebuilt with neither the tool call
    // nor its result in view, and re-issues the call every turn.
    //
    // In memory only, deliberately: the runner appends this same event
    // through the session service, and `VertexAiSessionService` posts to
    // the remote store unconditionally rather than deduping by event id,
    // so appending here too would write it twice on Agent Engine.
    const sessionEvents = invocationContext.session.events;
    const existing = sessionEvents.findIndex(
      (e) => e.id === functionResponseEvent.id,
    );
    if (existing >= 0) {
      sessionEvents[existing] = functionResponseEvent;
    } else {
      sessionEvents.push(functionResponseEvent);
    }
    yield functionResponseEvent;
  }
}

/**
 * The session events this invocation may act on: those on the current branch.
 *
 * A confirmation belongs to the branch that raised it. Without this an agent
 * could resume a sibling branch's paused call — an approval that was never
 * shown in this context, for a tool this agent may not even have. Mirrors
 * Python's `_get_events(current_branch=True)`.
 */
function eventsInScope(invocationContext: InvocationContext): Event[] {
  const events = invocationContext.session.events;
  const currentBranch = invocationContext.branch;
  if (!currentBranch) {
    return events;
  }
  return events.filter(
    (event) => !event.branch || isSegmentPrefix(currentBranch, event.branch),
  );
}

/**
 * The decisions carried by the user's latest turn, keyed by the id of the
 * `adk_request_confirmation` call each one answers.
 *
 * Only the latest user turn is read. An approval answers a question the
 * framework asked at that moment; letting an older, already-superseded turn
 * supply one lets a decision be resurrected out of its context. Mirrors Python,
 * which reads confirmations from the last user-authored event and stops there.
 */
function collectApprovals(
  events: Event[],
  allowPlainText: boolean,
): Map<string, ToolConfirmation> {
  const approvals = new Map<string, ToolConfirmation>();

  const latestUserEvent = findLatestUserEvent(events);
  if (!latestUserEvent) {
    return approvals;
  }

  for (const functionResponse of getFunctionResponses(latestUserEvent)) {
    if (functionResponse.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
      continue;
    }
    if (!functionResponse.id || !functionResponse.response) {
      continue;
    }
    approvals.set(
      functionResponse.id,
      parseToolConfirmation(functionResponse.response),
    );
  }

  // Plain-text fallback: an interactive user (e.g. `adk run`) can approve or
  // deny a pending confirmation by simply typing a reply (yes/no) instead of
  // sending a structured confirmation response. Opt-in only
  // (`runConfig.plainTextToolConfirmation`) so that on a web/API surface an
  // ordinary chat message is never silently reinterpreted as a tool-gate
  // decision — that binding is what the structured path exists to guarantee.
  if (approvals.size === 0 && allowPlainText) {
    return mapPlainTextConfirmation(events);
  }

  return approvals;
}

/** Reads a {@link ToolConfirmation} out of a confirmation function response. */
function parseToolConfirmation(
  response: Record<string, unknown>,
): ToolConfirmation {
  if (Object.keys(response).length === 1 && 'response' in response) {
    return JSON.parse(response['response'] as string) as ToolConfirmation;
  }
  return new ToolConfirmation({
    hint: response['hint'] as string,
    payload: response['payload'],
    confirmed: response['confirmed'] as boolean,
  });
}

/**
 * Maps each approval to the pinned call it unlocks, keyed by that call's id,
 * skipping approvals that have already been spent.
 */
function resolveResumableCalls(
  events: Event[],
  approvals: Map<string, ToolConfirmation>,
): Map<string, ResumableCall> {
  const resumable = new Map<string, ResumableCall>();

  for (const [index, event] of events.entries()) {
    for (const functionCall of getFunctionCalls(event)) {
      const confirmation = functionCall.id
        ? approvals.get(functionCall.id)
        : undefined;
      if (!confirmation) {
        continue;
      }
      const pinned = pinnedCall(functionCall);
      if (!pinned?.id) {
        continue;
      }
      if (hasRespondedAfter(events, pinned.id, index)) {
        continue;
      }
      resumable.set(pinned.id, {call: pinned, confirmation});
    }
  }

  return resumable;
}

/** The call an `adk_request_confirmation` request pinned for approval. */
function pinnedCall(functionCall: FunctionCall): FunctionCall | undefined {
  const args = functionCall.args;
  if (!args || !('originalFunctionCall' in args)) {
    return undefined;
  }
  const pinned = args['originalFunctionCall'];
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) {
    return undefined;
  }
  return pinned as FunctionCall;
}

/**
 * Whether the pinned call already produced a result after its gate was raised —
 * that is, whether this approval has already been spent.
 *
 * An approval authorizes one execution. The window opens at the gate rather
 * than covering all of history because the paused call already has a response
 * before the gate: the "requires confirmation" placeholder that raised it. It
 * never closes, so a captured decision replayed later in the session finds its
 * execution already on record and is refused — the hazard a window anchored on
 * the approval turn misses.
 */
function hasRespondedAfter(
  events: Event[],
  pinnedCallId: string,
  gateIndex: number,
): boolean {
  return events
    .slice(gateIndex + 1)
    .some((event) =>
      getFunctionResponses(event).some(
        (functionResponse) => functionResponse.id === pinnedCallId,
      ),
    );
}

/** The most recent user-authored event, if the session has one. */
function findLatestUserEvent(events: Event[]): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].author === 'user') {
      return events[i];
    }
  }
  return undefined;
}

/** Words interpreted as an approval when a user confirms by plain text. */
const AFFIRMATIVE = new Set([
  'yes',
  'y',
  'true',
  'approve',
  'approved',
  'ok',
  'okay',
  'confirm',
  'confirmed',
]);

/** Words interpreted as an explicit denial when a user confirms by plain text. */
const NEGATIVE = new Set([
  'no',
  'n',
  'false',
  'reject',
  'rejected',
  'deny',
  'denied',
  'cancel',
  'cancelled',
]);

/**
 * Maps a plain-text user reply to a confirmation for the single pending
 * `adk_request_confirmation` call it is answering, so an interactive user can
 * approve/deny by typing. Deliberately conservative (see the security review on
 * PR #594):
 *
 * - Only the SINGLE most-recent pending confirmation is resolved — never a
 *   broadcast across every unanswered gate in the history.
 * - The plain-text reply must IMMEDIATELY follow the confirmation request (no
 *   intervening user turn), so an unrelated later message can't resolve a stale
 *   gate.
 * - Only recognized affirmative/negative words decide; any other text (a
 *   question, a typo, an answer to something else) is left as NO decision so the
 *   gate stays pending rather than being silently denied.
 */
function mapPlainTextConfirmation(
  events: Event[],
): Map<string, ToolConfirmation> {
  const none = new Map<string, ToolConfirmation>();

  // The reply is the most recent user turn, and only if it is plain text.
  let turnIndex = -1;
  let text = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== 'user') {
      continue;
    }
    const parts = event.content?.parts ?? [];
    const isPlainText =
      parts.length > 0 && parts.every((p) => typeof p.text === 'string');
    if (isPlainText) {
      turnIndex = i;
      text = parts.map((p) => p.text).join('');
    }
    break;
  }
  if (turnIndex < 0) {
    return none;
  }

  const answered = new Set<string>();
  for (const event of events) {
    if (event.author !== 'user') {
      continue;
    }
    for (const fr of getFunctionResponses(event)) {
      if (fr.id) {
        answered.add(fr.id);
      }
    }
  }

  // Find the pending confirmation call the reply is answering: scan back from
  // the reply for the most recent unanswered `adk_request_confirmation`, and
  // require it to immediately precede the reply (stop at any other user turn).
  let pendingId: string | undefined;
  for (let i = turnIndex - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author === 'user') {
      break; // another user turn between request and reply -> not immediate
    }
    for (const fc of getFunctionCalls(event)) {
      if (
        fc.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
        fc.id &&
        !answered.has(fc.id)
      ) {
        pendingId = fc.id;
        break;
      }
    }
    if (pendingId) {
      break;
    }
  }
  if (!pendingId) {
    return none;
  }

  const normalized = text.trim().toLowerCase();
  let confirmed: boolean;
  if (AFFIRMATIVE.has(normalized)) {
    confirmed = true;
  } else if (NEGATIVE.has(normalized)) {
    confirmed = false;
  } else {
    return none; // unrecognized -> no decision, leave the gate pending
  }

  return new Map([[pendingId, new ToolConfirmation({confirmed})]]);
}

export const REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR =
  new RequestConfirmationLlmRequestProcessor();
