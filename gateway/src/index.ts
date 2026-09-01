/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {checkAccess} from './access.js';
export {DEFAULT_ERROR_TEXT, resolveAppName} from './config.js';
export type {
  CommandContext,
  CommandHandler,
  GatewayConfig,
  InboundContext,
  InboundHook,
} from './config.js';
export {toContent} from './content.js';
export type {ToContentOptions} from './content.js';
export {Gateway, createGateway} from './gateway.js';
export {createEndpoints} from './http/endpoints.js';
export type {EndpointOptions, ResolveUser} from './http/endpoints.js';
export {createRouter} from './http/router.js';
export type {
  RouterMiddleware,
  RouterRequest,
  RouterResponse,
} from './http/router.js';
export {
  DEFAULT_MAX_INLINE_BYTES,
  MAX_AUDIO_PARTS,
  attachmentsToParts,
  isAcceptedMimeType,
  normalizeMimeType,
} from './media/parts.js';
export type {MediaPolicy} from './media/parts.js';
export {chunkText} from './render/chunk.js';
export {applyFilter, filterEvents, isFinalEvent} from './render/filter.js';
export type {EventFilter} from './render/filter.js';
export {
  actionsFor,
  answerPart,
  interruptsIn,
  isInterruptAnswer,
  plainTextHint,
  promptFor,
} from './render/interrupts.js';
export type {GatewayInterrupt, InterruptAnswer} from './render/interrupts.js';
export {
  escapeHtml,
  stripTelegramHtml,
  toPlainText,
  toTelegramHtml,
} from './render/markdown.js';
export {
  applyFormat,
  defaultRenderer,
  formatAndChunk,
  renderInterrupt,
  textOf,
} from './render/renderer.js';
export type {RenderContext, Renderer} from './render/renderer.js';
export {SessionQueue} from './runtime/queue.js';
export type {
  BusyPolicy,
  QueueTask,
  RunOutcome,
  SessionQueueOptions,
} from './runtime/queue.js';
export {ActionTokenStore} from './runtime/tokens.js';
export type {ActionToken, ActionTokenStoreOptions} from './runtime/tokens.js';
export {
  ProvenanceKeys,
  discardSession,
  provenanceState,
  resolveSession,
} from './session/resolve.js';
export type {ResolveSessionParams, ResolvedSession} from './session/resolve.js';
export {
  computeCoordinates,
  isEphemeral,
  parseDuration,
  resolveSessionConfig,
} from './session/strategies.js';
export * from './types.js';
export {version} from './version.js';
