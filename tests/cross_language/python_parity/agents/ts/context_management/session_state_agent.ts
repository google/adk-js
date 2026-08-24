/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/context_management/session_state_agent.
 *
 * The agent to demo the session state lifecycle.
 *
 * This agent illustrate how session state will be cached in context and
 * persisted in session state.
 *
 * Ported as literally as the two APIs allow: same agent name, description and
 * instruction, the same four callbacks, the same state keys and the same
 * printed assertions. The assertions are the sample's whole point, so they
 * throw on both sides when the runtimes disagree about *when* a state delta
 * reaches the session service.
 *
 * The one surface difference: Python reads `ctx._invocation_context`, adk-js
 * exposes the same object publicly as `ctx.invocationContext`, and state is
 * `has`/`set` rather than `in`/`[]`.
 */
import type {Context} from '@google/adk';
import {LlmAgent} from '@google/adk';
import type {Content} from '@google/genai';

import {PARITY_MODEL} from '../model.ts';

/** Renders a string list the way Python's `print` renders one. */
function pyList(keys: string[]): string {
  return `[${keys.map((k) => `'${k}'`).join(', ')}]`;
}

async function assertSessionValues(
  ctx: Context,
  title: string,
  options: {
    keysInCtxSession?: string[];
    keysInServiceSession?: string[];
    keysNotInServiceSession?: string[];
  },
): Promise<void> {
  const sessionInCtx = ctx.invocationContext.session;
  const sessionService = ctx.invocationContext.sessionService;
  if (!sessionService) {
    throw new Error('Session service is not initialized.');
  }
  const sessionInService = await sessionService.getSession({
    appName: sessionInCtx.appName,
    userId: sessionInCtx.userId,
    sessionId: sessionInCtx.id,
  });
  if (sessionInService === undefined) {
    throw new Error('assert session_in_service is not None');
  }

  const {
    keysInCtxSession = [],
    keysInServiceSession = [],
    keysNotInServiceSession = [],
  } = options;

  console.log(`===================== ${title} ==============================`);
  process.stdout.write(
    `** Asserting keys are cached in context: ${pyList(keysInCtxSession)} `,
  );
  for (const key of keysInCtxSession) {
    if (!(key in sessionInCtx.state)) {
      throw new Error(`assert '${key}' in session_in_ctx.state`);
    }
  }
  console.log('\u001b[92mpass \u2705\u001b[0m');

  process.stdout.write(
    '** Asserting keys are already persisted in session:' +
      ` ${pyList(keysInServiceSession)} `,
  );
  for (const key of keysInServiceSession) {
    if (!(key in sessionInService.state)) {
      throw new Error(`assert '${key}' in session_in_service.state`);
    }
  }
  console.log('\u001b[92mpass \u2705\u001b[0m');

  process.stdout.write(
    '** Asserting keys are not persisted in session yet:' +
      ` ${pyList(keysNotInServiceSession)} `,
  );
  for (const key of keysNotInServiceSession) {
    if (key in sessionInService.state) {
      throw new Error(`assert '${key}' not in session_in_service.state`);
    }
  }
  console.log('\u001b[92mpass \u2705\u001b[0m');
  console.log('============================================================');
}

async function beforeAgentCallback(
  callbackContext: Context,
): Promise<Content | undefined> {
  if (callbackContext.state.has('before_agent_callback_state_key')) {
    return {
      role: 'model',
      parts: [{text: 'Sorry, I can only reply once.'}],
    };
  }

  callbackContext.state.set(
    'before_agent_callback_state_key',
    'before_agent_callback_state_value',
  );

  await assertSessionValues(callbackContext, 'In before_agent_callback', {
    keysInCtxSession: ['before_agent_callback_state_key'],
    keysInServiceSession: [],
    keysNotInServiceSession: ['before_agent_callback_state_key'],
  });
  return undefined;
}

async function beforeModelCallback({
  context,
}: {
  context: Context;
}): Promise<undefined> {
  context.state.set(
    'before_model_callback_state_key',
    'before_model_callback_state_value',
  );

  await assertSessionValues(context, 'In before_model_callback', {
    keysInCtxSession: [
      'before_agent_callback_state_key',
      'before_model_callback_state_key',
    ],
    keysInServiceSession: ['before_agent_callback_state_key'],
    keysNotInServiceSession: ['before_model_callback_state_key'],
  });
  return undefined;
}

async function afterModelCallback({
  context,
}: {
  context: Context;
}): Promise<undefined> {
  context.state.set(
    'after_model_callback_state_key',
    'after_model_callback_state_value',
  );

  await assertSessionValues(context, 'In after_model_callback', {
    keysInCtxSession: [
      'before_agent_callback_state_key',
      'before_model_callback_state_key',
      'after_model_callback_state_key',
    ],
    keysInServiceSession: ['before_agent_callback_state_key'],
    keysNotInServiceSession: [
      'before_model_callback_state_key',
      'after_model_callback_state_key',
    ],
  });
  return undefined;
}

async function afterAgentCallback(
  callbackContext: Context,
): Promise<undefined> {
  callbackContext.state.set(
    'after_agent_callback_state_key',
    'after_agent_callback_state_value',
  );

  await assertSessionValues(callbackContext, 'In after_agent_callback', {
    keysInCtxSession: [
      'before_agent_callback_state_key',
      'before_model_callback_state_key',
      'after_model_callback_state_key',
      'after_agent_callback_state_key',
    ],
    keysInServiceSession: [
      'before_agent_callback_state_key',
      'before_model_callback_state_key',
      'after_model_callback_state_key',
    ],
    keysNotInServiceSession: ['after_agent_callback_state_key'],
  });
  return undefined;
}

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  description: 'a verification agent.',
  instruction:
    'Reply to the user. Must always remind user you cannot answer a second' +
    ' query because your setup.',
  model: PARITY_MODEL,
  beforeAgentCallback,
  beforeModelCallback,
  afterModelCallback,
  afterAgentCallback,
});
