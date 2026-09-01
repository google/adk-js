/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The contract between the gateway and a messenger.
 *
 * A {@link ChannelAdapter} translates one messenger into the canonical shapes
 * here — {@link InboundMessage} in, {@link OutboundMessage} out — and declares
 * what that messenger can do via {@link ChannelCapabilities}. Everything
 * between the two is the gateway's: sessions, queueing, rendering, interrupts.
 */

import type {Logger} from '@google/adk';

// =============================================================================
// Capabilities
// =============================================================================

/** How a channel can show a reply as it is being generated. */
export type StreamingSupport =
  /**
   * The channel has a first-class "partial reply" API — Telegram's message
   * drafts, for instance. Preferred when present: it is not rate-limited the
   * way message edits are, and it usually carries a native "thinking"
   * affordance.
   */
  | 'native-draft'
  /** Progressive output is possible only by editing a sent message. */
  | 'edit'
  /** No progressive output. The turn is buffered and sent once. */
  | 'none';

/** How a channel renders choices the user can tap. */
export type ButtonSupport = 'inline' | 'quick-reply' | 'cards' | 'none';

/** The markup dialect a channel's message text is parsed as. */
export type TextFormat =
  | 'plain'
  | 'markdown'
  | 'markdownv2'
  | 'html'
  | 'slack-mrkdwn'
  | 'chat-cardv2';

/** What a channel permits when the bot speaks first. */
export interface ProactiveCapability {
  /** Whether the channel allows messaging a conversation outside a turn. */
  supported: boolean;

  /**
   * How long after the user's last message free-form text is allowed.
   *
   * WhatsApp enforces a 24-hour window, after which only pre-approved
   * templates may be sent. Omitted where there is no such limit.
   */
  freeformWindowMs?: number;

  /** Whether messages outside {@link freeformWindowMs} must be templates. */
  requiresTemplate: boolean;
}

/**
 * What a channel can do.
 *
 * The renderer reads these rather than branching on channel name, which is what
 * lets one rendering pipeline serve messengers as different as Telegram and
 * WhatsApp. A new adapter that declares its capabilities honestly gets correct
 * chunking, degradation and streaming behavior without writing any of it.
 */
export interface ChannelCapabilities {
  /** Longest single message body, in characters. */
  maxTextLength: number;

  /** The dialect {@link OutboundMessage.text} is converted to before sending. */
  textFormat: TextFormat;

  /** Whether an already-sent message can be edited. */
  editMessages: boolean;

  /** How progressive output is delivered, if at all. */
  streaming: StreamingSupport;

  /** Whether a "typing…" indicator can be shown. */
  typingIndicator: boolean;

  /** How tappable choices are rendered. */
  buttons: ButtonSupport;

  /**
   * Largest payload a button may carry, in bytes.
   *
   * Telegram caps `callback_data` at 64 bytes, which is far too small for an
   * interrupt id plus its answer, so the gateway routes button payloads through
   * a token store when this is small. `Infinity` means "no practical limit".
   */
  buttonPayloadBytes: number;

  /** Whether the channel has a native thread/topic concept. */
  threads: boolean;

  /** What the channel can carry alongside text. */
  attachments: {
    upload: boolean;
    download: boolean;
    /** Largest single file, in bytes. */
    maxBytes: number;
  };

  /** What the channel permits when the bot speaks first. */
  proactive: ProactiveCapability;
}

// =============================================================================
// Conversations, targets and message references
// =============================================================================

/** What kind of place a conversation happens in. */
export type ConversationKind = 'direct' | 'group' | 'channel';

/** Where a conversation is, in one channel's own terms. */
export interface ConversationRef {
  /** The channel this conversation belongs to, e.g. `'telegram'`. */
  channel: string;

  /** The channel's own id for the chat, space or room. */
  id: string;

  /** The channel's own id for the thread or topic, when the message is in one. */
  threadId?: string;

  /** What kind of place this is. Absent when not yet known. */
  kind?: ConversationKind;

  /** Human-readable name, for logs and for group prompting. */
  title?: string;
}

/** Where an adapter should deliver a message. */
export interface ChannelTarget {
  /** The channel's own id for the chat, space or room. */
  conversationId: string;

  /** The channel's own id for the thread or topic, when replying into one. */
  threadId?: string;
}

/**
 * A handle on a message the bot sent, sufficient to edit or delete it later.
 */
export interface MessageRef {
  channel: string;
  conversationId: string;
  messageId: string;
  threadId?: string;
}

// =============================================================================
// Inbound
// =============================================================================

/** What sort of thing an inbound attachment is. */
export type AttachmentKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location';

/**
 * A file that arrived with a message.
 *
 * The bytes are deliberately **not** fetched during normalization: a 20 MB
 * video attached by a user who turns out to be blocked, or whose media kind the
 * policy rejects, should never be downloaded at all. {@link download} is the
 * only thing that costs network.
 */
export interface InboundAttachment {
  kind: AttachmentKind;

  /**
   * The media type, as reported by the sending platform.
   *
   * Captured here at normalization time on purpose. Telegram's `getFile`, for
   * one, explicitly does not preserve the mime type or file name, so reading
   * them back off the download is too late.
   */
  mimeType?: string;

  fileName?: string;
  sizeBytes?: number;

  /** Duration in seconds, for audio and video. */
  durationSec?: number;

  /** Fetches the bytes. Not called unless the media policy admits this file. */
  download(): Promise<Uint8Array>;
}

/** A button press or other non-text interaction. */
export interface InboundAction {
  /**
   * The channel's own id for this interaction, needed to acknowledge it.
   * Telegram, for instance, requires an `answerCallbackQuery` or the client
   * spins indefinitely.
   */
  id: string;

  /**
   * What the button carried. Already resolved from the token store when the
   * channel's {@link ChannelCapabilities.buttonPayloadBytes} forced one.
   */
  payload: unknown;
}

/** A slash command, parsed out of the message text. */
export interface InboundCommand {
  /** The command without its leading slash or bot suffix: `'reset'`. */
  name: string;
  /** Everything after the command name, trimmed. */
  args: string;
}

/** One message from a messenger, in canonical form. */
export interface InboundMessage {
  /** The channel it arrived on, e.g. `'telegram'`. */
  channel: string;

  conversation: ConversationRef;

  sender: {
    /** The channel's own id for this person. */
    id: string;
    displayName?: string;
    username?: string;
    isBot?: boolean;
  };

  /** The channel's own id for this message. */
  messageId: string;

  text?: string;

  attachments: InboundAttachment[];

  /** Set when this "message" is really a button press. */
  action?: InboundAction;

  /** Set when the text was a slash command. */
  command?: InboundCommand;

  /**
   * The message this one replies to.
   *
   * Load-bearing for human-in-the-loop: a free-text answer to a prompt is
   * matched back to the interrupt by the message it replies to.
   */
  replyTo?: {messageId: string; fromBot: boolean};

  /** Whether the bot was addressed directly. Always true in a direct chat. */
  mentionsBot: boolean;

  receivedAt: Date;

  /**
   * The untouched platform payload.
   *
   * An escape hatch, always populated. Anything an adapter cannot express in
   * the canonical shape is still reachable here.
   */
  raw: unknown;
}

// =============================================================================
// Outbound
// =============================================================================

/** What sort of thing an outbound attachment is. */
export type OutboundAttachmentKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'voice'
  | 'video-note';

/** A file to send. */
export interface OutboundAttachment {
  kind: OutboundAttachmentKind;

  /** The bytes, when the gateway holds them. */
  bytes?: Uint8Array;

  /**
   * A channel-native id for a file the platform already has, when the gateway
   * does not hold the bytes. Telegram `file_id`, for instance.
   */
  fileId?: string;

  mimeType?: string;
  fileName?: string;
  caption?: string;
}

/** A tappable choice offered to the user. */
export interface OutboundAction {
  /** What the button says. */
  label: string;

  /**
   * What comes back when it is pressed.
   *
   * The gateway substitutes an opaque token where the channel's payload budget
   * is too small, so this may be any size.
   */
  payload: unknown;

  /** A hint at prominence. Channels without the concept ignore it. */
  style?: 'primary' | 'danger';
}

/** One message to send, before channel-specific rendering. */
export interface OutboundMessage {
  text?: string;

  attachments?: OutboundAttachment[];

  actions?: OutboundAction[];

  /** The channel's own id of a message to reply to. */
  replyTo?: string;

  /**
   * Whether this is a status line the gateway may edit away once the turn is
   * done, rather than part of the answer.
   */
  transient?: boolean;
}

// =============================================================================
// Session strategy
// =============================================================================

/**
 * How inbound messages are grouped into ADK sessions.
 *
 * - `per-conversation` — one session per chat, plus thread when the message is
 *   in one. Everyone in a group shares the agent's memory.
 * - `per-user` — one session per person, no matter where they speak from.
 * - `per-thread` — one session per thread, falling back to the conversation
 *   when a message is not in a thread.
 * - `ephemeral` — a fresh session per message, discarded after the turn. No
 *   memory between messages.
 *
 * A plain string is the whole strategy: the knobs that exist
 * ({@link SessionConfig.idleTtl}, {@link SessionConfig.groupIdentity}) apply
 * identically to all four, so none of them takes options of its own.
 */
export type SessionKey =
  | 'per-conversation'
  | 'per-user'
  | 'per-thread'
  | 'ephemeral';

/** The ADK session coordinates a message maps to. */
export interface SessionCoordinates {
  userId: string;
  sessionId: string;
}

/** A caller-supplied strategy, for cases the four built-ins do not cover. */
export type SessionKeyFn = (message: InboundMessage) => SessionCoordinates;

/** How a channel maps messages to sessions. */
export interface SessionConfig {
  /** A built-in strategy, or a function for full control. */
  key: SessionKey | SessionKeyFn;

  /**
   * Start a fresh session when the previous message is older than this.
   *
   * Milliseconds, or a duration string like `'24h'`. Chat conversations
   * otherwise run for months and outgrow the model's context window.
   */
  idleTtl?: string | number;

  /**
   * Whether to prefix each message with its speaker in multi-party
   * conversations, so the model can tell participants apart.
   *
   * Defaults to `'prefix'` in groups and channels, `'none'` in direct chats.
   */
  groupIdentity?: 'prefix' | 'none';
}

// =============================================================================
// Access
// =============================================================================

/**
 * Who may talk to the bot on one channel.
 *
 * Deliberately channel-scoped and with no gateway-level counterpart: two layers
 * of allowlist would need precedence rules, and access control is exactly where
 * unclear precedence turns into an accidentally open bot. To share one policy
 * across channels, share the object.
 *
 * Ids here are the channel's own, unprefixed — inside a channel's config there
 * is nothing else they could refer to.
 */
export interface AccessPolicy {
  /** If set, only these sender ids are allowed. */
  allowUsers?: readonly string[];

  /** If set, only these conversation ids are allowed. */
  allowConversations?: readonly string[];

  /** Whether to respond in groups and channels at all. Defaults to true. */
  allowGroups?: boolean;

  /** Called instead of running the agent when a message is denied. */
  onDenied?: (message: InboundMessage, reason: AccessDenialReason) => void;
}

/** Why a message was refused. */
export type AccessDenialReason =
  | 'user-not-allowed'
  | 'conversation-not-allowed'
  | 'groups-not-allowed';

// =============================================================================
// Adapter
// =============================================================================

/** A handler for one channel's inbound webhook. */
export type WebhookHandler = (request: {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}) => Promise<{status: number; body?: unknown}>;

/** Reserved for full-duplex audio. Not implemented in v1. */
export interface LiveChannelHandle {
  close(): Promise<void>;
}

/** What the gateway hands an adapter when it starts. */
export interface ChannelRuntime {
  /**
   * Hands one normalized message to the gateway pipeline.
   *
   * Resolves when the turn is complete. An adapter that must acknowledge
   * ingress promptly — Slack's three-second deadline — should not await it.
   */
  dispatch(message: InboundMessage): Promise<void>;

  logger: Logger;

  /** Aborted when the gateway stops. Long-poll loops should honour it. */
  signal: AbortSignal;
}

/**
 * One messenger, adapted.
 *
 * Implementations translate updates into {@link InboundMessage} and
 * {@link OutboundMessage} into platform API calls. They own transport, auth and
 * payload shape; they do not own sessions, queueing, rendering or access
 * enforcement, all of which the gateway does once for every channel.
 */
export interface ChannelAdapter {
  /** Stable channel name, e.g. `'telegram'`. Used in ids and telemetry. */
  readonly name: string;

  /** What this channel can do, in general. */
  readonly capabilities: ChannelCapabilities;

  /**
   * What this channel can do in one particular conversation.
   *
   * Capabilities are not always uniform across a channel: Telegram's native
   * draft streaming works in direct chats but not in groups. Adapters whose
   * capabilities never vary can leave this unimplemented.
   */
  capabilitiesFor?(conversation: ConversationRef): ChannelCapabilities;

  /**
   * How this channel maps messages to sessions, already resolved from the
   * channel's own default and whatever the caller overrode.
   */
  readonly session: SessionConfig;

  /** Who may talk to the bot here. Absent means everyone. */
  readonly access?: AccessPolicy;

  /** The webhook route to mount, for channels that receive by push. */
  readonly webhook?: {path: string; handle: WebhookHandler};

  /** Begins receiving. Returns once the channel is ready, not when it stops. */
  start(runtime: ChannelRuntime): Promise<void>;

  /** Stops receiving and releases resources. */
  stop(): Promise<void>;

  send(target: ChannelTarget, message: OutboundMessage): Promise<MessageRef>;

  /** Required when {@link ChannelCapabilities.editMessages} is true. */
  edit?(ref: MessageRef, message: OutboundMessage): Promise<MessageRef>;

  delete?(ref: MessageRef): Promise<void>;

  /** Required when {@link ChannelCapabilities.typingIndicator} is true. */
  typing?(target: ChannelTarget, on: boolean): Promise<void>;

  /**
   * Acknowledges a button press.
   *
   * Some channels require this promptly and independently of any reply —
   * Telegram's client shows a spinner until `answerCallbackQuery` arrives.
   */
  ackAction?(actionId: string, note?: string): Promise<void>;

  /**
   * Reserved for full-duplex audio, over core's `runLive` and
   * `LiveRequestQueue`. Not implemented in v1.
   */
  openLive?(target: ChannelTarget): Promise<LiveChannelHandle>;
}
