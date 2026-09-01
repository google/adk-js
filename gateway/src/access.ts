/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deciding whether a message is allowed to reach the agent.
 *
 * Policy is configured per channel (see {@link AccessPolicy}) but enforced here,
 * once, for every channel — an adapter should not be able to get this subtly
 * wrong on its own. There is no cost to checking after normalization because
 * attachment bytes are fetched lazily: a denied message maps a few fields and
 * downloads nothing.
 */

import type {
  AccessDenialReason,
  AccessPolicy,
  InboundMessage,
} from './types.js';

/**
 * Returns why a message should be refused, or `undefined` to allow it.
 *
 * An absent policy allows everything, which is the right default for a bot
 * nobody has configured yet — it is reachable only by whoever holds the token.
 */
export function checkAccess(
  policy: AccessPolicy | undefined,
  message: InboundMessage,
): AccessDenialReason | undefined {
  if (!policy) {
    return undefined;
  }

  const kind = message.conversation.kind ?? 'direct';
  if (policy.allowGroups === false && kind !== 'direct') {
    return 'groups-not-allowed';
  }

  if (policy.allowUsers && !policy.allowUsers.includes(message.sender.id)) {
    return 'user-not-allowed';
  }

  if (
    policy.allowConversations &&
    !policy.allowConversations.includes(message.conversation.id)
  ) {
    return 'conversation-not-allowed';
  }

  return undefined;
}
