/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {BaseAgent} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event} from '../events/event.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {toContent} from './base_node.js';
import {NodeContext} from './node_context.js';
import {reconstructNodeStates} from './utils/rehydration_utils.js';
import {Workflow} from './workflow.js';

/** Options for a {@link WorkflowAgent}. */
export interface WorkflowAgentConfig {
  name?: string;
  description?: string;
}

/**
 * Adapts a {@link Workflow} (a `BaseNode`) into a `BaseAgent` so it can be run by
 * the standard ADK `Runner`.
 *
 * It sets up the event channel bridge: the workflow's node execution pushes
 * events into the channel while this agent's `runAsyncImpl` drains and re-yields
 * them to the runtime. The user message (`ctx.userContent`) becomes the
 * workflow input.
 */
export class WorkflowAgent extends BaseAgent {
  readonly workflow: Workflow;

  constructor(workflow: Workflow, config: WorkflowAgentConfig = {}) {
    super({
      name: config.name ?? workflow.name,
      description: config.description ?? workflow.description,
    });
    this.workflow = workflow;
  }

  protected async *runAsyncImpl(
    ic: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: this.name,
      // Interactive resume: if the workflow is paused on an interrupt and the
      // user replies with plain text (not a structured function response), feed
      // that text to the pending interrupt(s). Structured function responses are
      // still resolved by the workflow's own rehydration.
      resumeInputs: resumeInputsFromPlainText(ic),
    });

    const input = extractWorkflowInput(ic.userContent);

    const settle = (async () => {
      try {
        const wfCtx = await root.runNode(this.workflow, input, {
          useAsOutput: true,
        });
        // Surface the workflow's final output as an event so consumers (and
        // the Runner) can observe it — important for dynamicEntry workflows
        // whose return value differs from the last node's event.
        if (wfCtx.interruptIds.length === 0 && root.output !== undefined) {
          channel.push(
            createEvent({
              author: this.name,
              invocationId: ic.invocationId,
              branch: ic.branch,
              content: toContent(root.output),
              output: root.output,
            }),
          );
        }
        channel.close();
      } catch (err) {
        channel.fail(err);
      }
    })();

    for await (const event of channel) {
      yield event;
    }
    await settle;
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('WorkflowAgent does not support live mode.');
  }
}

/**
 * When the workflow is paused on unresolved interrupt(s) and the incoming
 * message is plain text (not a structured function response), maps that text to
 * every pending interrupt id so an interactive client (e.g. `adk run`) can
 * resume a HITL/auth pause by simply typing a reply.
 */
function resumeInputsFromPlainText(
  ic: InvocationContext,
): Record<string, unknown> {
  const parts = ic.userContent?.parts ?? [];
  const isPlainText =
    parts.length > 0 && parts.every((p) => typeof p.text === 'string');
  if (!isPlainText) {
    return {};
  }
  const text = parts.map((p) => p.text).join('');

  const pending = new Set<string>();
  for (const node of reconstructNodeStates(ic.session?.events ?? []).values()) {
    for (const id of node.interruptIds) {
      if (!node.resolvedResponses.has(id)) {
        pending.add(id);
      }
    }
  }

  const resumeInputs: Record<string, unknown> = {};
  for (const id of pending) {
    resumeInputs[id] = text;
  }
  return resumeInputs;
}

/**
 * Derives the workflow input from the user message: plain text when the content
 * is text-only, otherwise the raw `Content` (nodes coerce as needed).
 */
function extractWorkflowInput(content?: Content): unknown {
  if (!content) {
    return undefined;
  }
  const parts = content.parts ?? [];
  if (parts.length > 0 && parts.every((p) => typeof p.text === 'string')) {
    return parts.map((p) => p.text).join('');
  }
  return content;
}
