/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The pipeline between a messenger and a runner.
 *
 * ```
 * inbound → access → command → onInbound hook
 *         → session get-or-create → build Content
 *         → per-session queue
 *         → runner.runAsync
 *         → render → adapter.send
 * ```
 */

import {
  getLogger,
  InMemorySessionService,
  Runner,
  type BaseSessionService,
  type Event,
  type Logger,
} from '@google/adk';

import type {Content} from '@google/genai';

import {checkAccess} from './access.js';
import {
  DEFAULT_ERROR_TEXT,
  resolveAppName,
  type CommandContext,
  type CommandHandler,
  type GatewayConfig,
} from './config.js';
import {toContent} from './content.js';
import {createRouter, type RouterMiddleware} from './http/router.js';
import {answerPart, isInterruptAnswer} from './render/interrupts.js';
import {defaultRenderer, type Renderer} from './render/renderer.js';
import {SessionQueue} from './runtime/queue.js';
import {ActionTokenStore} from './runtime/tokens.js';
import {discardSession, resolveSession} from './session/resolve.js';
import {computeCoordinates} from './session/strategies.js';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelTarget,
  InboundMessage,
  OutboundMessage,
} from './types.js';

/** Serves one or more messengers with an ADK agent. */
export class Gateway {
  private readonly config: GatewayConfig;
  private readonly appName: string;
  private readonly sessionService: BaseSessionService;
  private readonly runner: Runner;
  private readonly queue: SessionQueue;
  private readonly tokens: ActionTokenStore;
  private readonly render: Renderer;
  private readonly commands: Map<string, CommandHandler>;
  private readonly logger: Logger;
  private readonly channels = new Map<string, ChannelAdapter>();
  private controller?: AbortController;
  private running = false;

  constructor(config: GatewayConfig) {
    if (!config.channels?.length) {
      throw new Error('Gateway needs at least one channel.');
    }
    if (!config.app && !config.agent) {
      throw new Error('Gateway needs an `app` or an `agent` to run.');
    }

    this.config = config;
    this.appName = resolveAppName(config);
    this.sessionService = config.sessionService ?? new InMemorySessionService();
    this.logger = config.logger ?? getLogger();
    this.render = config.render ?? defaultRenderer;
    this.queue = new SessionQueue({
      onBusy: config.onBusy,
      maxQueued: config.maxQueued,
    });
    this.tokens = config.actionTokens ?? new ActionTokenStore();

    this.runner = new Runner({
      app: config.app,
      appName: this.appName,
      agent: config.app ? undefined : config.agent,
      plugins: config.plugins,
      sessionService: this.sessionService,
      artifactService: config.artifactService,
      memoryService: config.memoryService,
    });

    this.commands = buildCommands(config.commands);

    for (const channel of config.channels) {
      if (this.channels.has(channel.name)) {
        throw new Error(`Duplicate channel name: '${channel.name}'.`);
      }
      this.channels.set(channel.name, channel);
    }
  }

  /** Starts every channel. Resolves once they are all receiving. */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.controller = new AbortController();

    const signal = this.controller.signal;
    await Promise.all(
      [...this.channels.values()].map((channel) =>
        channel.start({
          dispatch: (message) => this.handleInbound(message),
          logger: this.logger,
          signal,
        }),
      ),
    );
  }

  /**
   * Stops accepting messages, lets in-flight turns finish, then stops every
   * channel.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.controller?.abort();

    await this.queue.drain();
    await Promise.all([...this.channels.values()].map((c) => c.stop()));
  }

  /**
   * Runs one inbound message all the way through.
   *
   * Adapters reach this via `ChannelRuntime.dispatch`. It is public because a
   * test, or an adapter with its own ingress, may want to drive it directly.
   */
  async handleInbound(message: InboundMessage): Promise<void> {
    const channel = this.channels.get(message.channel);
    if (!channel) {
      throw new Error(
        `Message from unregistered channel '${message.channel}'.`,
      );
    }

    const denial = checkAccess(channel.access, message);
    if (denial) {
      // Reported to the operator, never echoed to the sender: telling someone
      // why they were refused tells them what to try next.
      this.logger.debug?.(
        `[gateway] denied ${message.channel} message from ${message.sender.id}: ${denial}`,
      );
      channel.access?.onDenied?.(message, denial);
      return;
    }

    if (message.command) {
      const handled = await this.runCommand(channel, message);
      if (handled) {
        return;
      }
    }

    if (this.config.onInbound) {
      const verdict = await this.config.onInbound(message, {
        reply: (text) => this.reply(channel, message, {text}),
      });
      if (verdict === false) {
        return;
      }
    }

    await this.runTurn(channel, message);
  }

  /** Resolves a session, runs the agent, and sends whatever comes back. */
  private async runTurn(
    channel: ChannelAdapter,
    message: InboundMessage,
  ): Promise<void> {
    const resolved = await resolveSession({
      sessionService: this.sessionService,
      appName: this.appName,
      message,
      config: channel.session,
    });

    const content = message.action
      ? this.answerContent(message, resolved.coordinates.sessionId)
      : await toContent(message, {
          groupIdentity: channel.session.groupIdentity,
          media: this.config.media,
        });
    if (!content) {
      return;
    }

    const capabilities = capabilitiesFor(channel, message);

    await this.queue.run(resolved.coordinates.sessionId, async (signal) => {
      try {
        const events = this.runner.runAsync({
          userId: resolved.coordinates.userId,
          sessionId: resolved.coordinates.sessionId,
          newMessage: content,
          abortSignal: signal,
          runConfig: {
            // Lets a user answer a confirmation by typing "yes" as well as by
            // pressing a button. ADK gates this tightly: only the single most
            // recent pending confirmation, only when the reply immediately
            // follows it, and only for recognized yes/no words.
            plainTextToolConfirmation:
              this.config.plainTextConfirmation ?? true,
          },
        });

        for await (const outbound of this.render(events, {
          capabilities,
          formatError: this.config.formatError,
        })) {
          await this.reply(
            channel,
            message,
            this.tokenize(outbound, resolved.coordinates.sessionId),
          );
        }
      } catch (error) {
        // An aborted turn is a deliberate interruption, not a failure to
        // report: the user either sent a newer message or the gateway stopped.
        if (signal.aborted) {
          return;
        }
        this.logger.error?.(`[gateway] turn failed: ${describeError(error)}`);
        await this.reply(channel, message, {
          text: this.config.formatError?.(error) ?? DEFAULT_ERROR_TEXT,
        });
      } finally {
        if (resolved.ephemeral) {
          await discardSession(
            this.sessionService,
            this.appName,
            resolved.coordinates,
          );
        }
      }
    });
  }

  /** Runs a slash command. Returns whether one matched. */
  private async runCommand(
    channel: ChannelAdapter,
    message: InboundMessage,
  ): Promise<boolean> {
    const handler = this.commands.get(message.command!.name);
    if (!handler) {
      return false;
    }

    const context: CommandContext = {
      message,
      reply: (text) => this.reply(channel, message, {text}),
      resetSession: async () => {
        await discardSession(
          this.sessionService,
          this.appName,
          computeCoordinates(channel.session, message),
        );
      },
    };

    await handler(context);
    return true;
  }

  private async reply(
    channel: ChannelAdapter,
    message: InboundMessage,
    outbound: OutboundMessage,
  ): Promise<void> {
    await channel.send(targetOf(message), outbound);
  }

  /**
   * Replaces button payloads with opaque tokens.
   *
   * Done here rather than in each adapter so every channel gets the same
   * guarantee: a payload that comes back from a client is a handle this gateway
   * issued for this session, not something the client made up.
   */
  private tokenize(
    outbound: OutboundMessage,
    sessionId: string,
  ): OutboundMessage {
    if (!outbound.actions?.length) {
      return outbound;
    }

    return {
      ...outbound,
      actions: outbound.actions.map((action) => {
        if (!isInterruptAnswer(action.payload)) {
          return action;
        }
        return {
          ...action,
          payload: this.tokens.issue({sessionId, ...action.payload}),
        };
      }),
    };
  }

  /**
   * The `functionResponse` a button press stands for.
   *
   * Returns nothing when the token is unknown, expired, already spent, or was
   * issued for a different session — a press that cannot be accounted for is
   * ignored rather than guessed at.
   */
  private answerContent(
    message: InboundMessage,
    sessionId: string,
  ): Content | undefined {
    const id = message.action?.payload;
    if (typeof id !== 'string') {
      return undefined;
    }

    const token = this.tokens.consume(id, sessionId);
    if (!token) {
      this.logger.debug?.(
        `[gateway] ignoring a button press with no live token (${message.channel})`,
      );
      return undefined;
    }

    return {role: 'user', parts: [answerPart(token)]};
  }

  /**
   * Middleware serving every channel's webhook path.
   *
   * Mount it on your own server: `app.use(gateway.router())`. Channels that
   * receive by polling contribute nothing to it.
   */
  router(): RouterMiddleware {
    return createRouter([...this.channels.values()]);
  }
}

/** Builds a gateway. */
export function createGateway(config: GatewayConfig): Gateway {
  return new Gateway(config);
}

/** Where a reply to this message should go. */
function targetOf(message: InboundMessage): ChannelTarget {
  return {
    conversationId: message.conversation.id,
    threadId: message.conversation.threadId,
  };
}

/** A channel's capabilities for the conversation a message arrived in. */
function capabilitiesFor(
  channel: ChannelAdapter,
  message: InboundMessage,
): ChannelCapabilities {
  return (
    channel.capabilitiesFor?.(message.conversation) ?? channel.capabilities
  );
}

/**
 * Command handlers, with the built-ins filled in.
 *
 * Names are stored without a leading slash so that `'/reset'` and `'reset'`
 * both work in user configuration.
 */
function buildCommands(
  configured: Record<string, CommandHandler> | undefined,
): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();

  commands.set('reset', async (context) => {
    await context.resetSession();
    await context.reply('Started a new conversation.');
  });

  for (const [name, handler] of Object.entries(configured ?? {})) {
    commands.set(name.replace(/^\//, ''), handler);
  }

  return commands;
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

/** Re-exported so callers can name what `runAsync` yields. */
export type {Event};
