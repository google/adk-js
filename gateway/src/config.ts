/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a gateway is configured with.
 *
 * The split between what lives here and what lives on a channel follows one
 * rule: **configuration belongs to the layer whose constraints it encodes.**
 * ADK and model constraints are gateway-wide, because they do not vary by
 * messenger. Anything shaped by a messenger's own architecture — who may talk
 * to the bot, how conversations map to sessions, how its media behaves — is
 * configured on the channel.
 */

import type {
  App,
  BaseArtifactService,
  BaseMemoryService,
  BasePlugin,
  BaseSessionService,
  Logger,
  RunnableNode,
} from '@google/adk';

import type {MediaPolicy} from './media/parts.js';
import type {Renderer} from './render/renderer.js';
import type {BusyPolicy} from './runtime/queue.js';
import type {ActionTokenStore} from './runtime/tokens.js';
import type {ChannelAdapter, InboundMessage} from './types.js';

/** What a command handler can do. */
export interface CommandContext {
  message: InboundMessage;
  /** Sends a message back to where the command came from. */
  reply(text: string): Promise<void>;
  /** Discards the conversation's session, so the next turn starts fresh. */
  resetSession(): Promise<void>;
}

/** Handles one slash command. */
export type CommandHandler = (context: CommandContext) => Promise<void> | void;

/** What an inbound hook can do, beyond inspecting the message. */
export interface InboundContext {
  reply(text: string): Promise<void>;
}

/**
 * Called for every message that passes access control.
 *
 * Return `false` to stop the message going any further; anything else lets it
 * through.
 */
export type InboundHook = (
  message: InboundMessage,
  context: InboundContext,
) => Promise<boolean | void> | boolean | void;

/** How to build a gateway. */
export interface GatewayConfig {
  // ---------------------------------------------------------------------------
  // What to run. Provide `app`, or `agent` (with `appName` when the agent's own
  // name is not what sessions should be filed under).
  // ---------------------------------------------------------------------------

  app?: App;
  agent?: RunnableNode;
  appName?: string;
  plugins?: BasePlugin[];

  /** Defaults to an in-memory service, which is fine until you restart. */
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
  memoryService?: BaseMemoryService;

  // ---------------------------------------------------------------------------
  // Where to run it.
  // ---------------------------------------------------------------------------

  /** The messengers to serve. At least one. */
  channels: ChannelAdapter[];

  // ---------------------------------------------------------------------------
  // Behavior.
  // ---------------------------------------------------------------------------

  /** What to do when a message arrives mid-turn. Defaults to `'queue'`. */
  onBusy?: BusyPolicy;

  /** How many messages may wait per session. Defaults to 8. */
  maxQueued?: number;

  /** Replaces the default event-to-message rendering wholesale. */
  render?: Renderer;

  /** Turns a failed turn into something worth showing the user. */
  formatError?: (error: unknown) => string;

  /**
   * Slash commands, keyed with or without the leading slash.
   *
   * `/reset` is provided unless overridden. Command *behavior* is application
   * logic and so lives here; parsing a channel's command syntax is the
   * adapter's job.
   */
  commands?: Record<string, CommandHandler>;

  /** Called for each message after access control, before the agent runs. */
  onInbound?: InboundHook;

  /**
   * Whether a typed "yes" or "no" may answer a pending tool confirmation, as
   * well as a button press. Defaults to true.
   *
   * Chat is a conversation, and being told to press a button when you have
   * already typed "yes" is a poor experience. ADK gates this narrowly: only the
   * single most recent pending confirmation, only when the reply immediately
   * follows the request, and only for recognized yes/no words. Set false on a
   * surface where an ordinary message must never be read as approval.
   */
  plainTextConfirmation?: boolean;

  /**
   * Where button payloads are kept.
   *
   * Defaults to an in-memory store, which is right until you run more than one
   * instance — a button offered by one process must be resolvable by whichever
   * process handles the press.
   */
  actionTokens?: ActionTokenStore;

  /**
   * How inbound files are admitted.
   *
   * Gateway-level because these limits are the model's — Gemini takes one audio
   * file per request whichever messenger it arrived from. How a *channel's*
   * media behaves (what to do with a sticker, say) is configured on the channel.
   */
  media?: MediaPolicy;

  logger?: Logger;
}

/** The default message shown when a turn throws. */
export const DEFAULT_ERROR_TEXT =
  'Sorry — something went wrong handling that. Please try again.';

/** Works out the app name sessions are filed under. */
export function resolveAppName(config: GatewayConfig): string {
  const name = config.appName ?? config.app?.name ?? config.agent?.name;
  if (!name) {
    throw new Error(
      'Gateway needs an app name: pass `app`, or an `agent` with a name, or ' +
        'set `appName` explicitly.',
    );
  }
  return name;
}
