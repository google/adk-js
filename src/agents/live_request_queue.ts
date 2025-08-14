/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ActivityEnd, ActivityStart, Blob, Content} from '@google/genai';

/**
 * Request sent to live agents.
 */
export interface LiveRequest {
  /** If set, send the content to the model in turn-by-turn mode. */
  content?: Content;
  /** If set, send the blob to the model in realtime mode. */
  blob?: Blob;
  /** If set, signal the start of user activity to the model. */
  activityStart?: ActivityStart;
  /** If set, signal the end of user activity to the model. */
  activityEnd?: ActivityEnd;
  /** If set, close the queue. */
  close?: boolean;
}

/** Function type for resolving a Promise with a LiveRequest. */
type PromiseResolveFn = (req: LiveRequest) => void;

/**
 * Queue used to send LiveRequest in a live (bidirectional streaming) way.
 */
export class LiveRequestQueue {
  // Keeps track of the data that are waiting to be sent.
  private readonly queue: LiveRequest[] = [];
  // Keeps track of the promises that are waiting for data.
  private readonly resolveFnFifoQueue: PromiseResolveFn[] = [];
  private isClosed = false;

  /**
   * Adds a request to the queue. If there is a pending `get()` call, it
   * will be resolved with the given request.
   * @param req The request to send.
   */
  send(req: LiveRequest) {
    if (this.isClosed) {
      throw new Error('Cannot send to a closed queue.');
    }
    if (this.resolveFnFifoQueue.length > 0) {
      const resolve = this.resolveFnFifoQueue.shift()!;
      resolve(req);
    } else {
      this.queue.push(req);
    }
  }

  /**
   * Retrieves a request from the queue. If the queue is empty, it will
   * wait until a request is available.
   * @returns A promise that resolves with the next available request.
   */
  async get(): Promise<LiveRequest> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.isClosed) {
      return {close: true};
    }
    return new Promise<LiveRequest>((resolve) => {
      this.resolveFnFifoQueue.push(resolve);
    });
  }

  /**
   * Sends a close signal to the queue.
   */
  close() {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    // Satisfy pending gets with existing queue items
    while (this.resolveFnFifoQueue.length > 0 && this.queue.length > 0) {
      const resolve = this.resolveFnFifoQueue.shift()!;
      const req = this.queue.shift()!;
      resolve(req);
    }

    // Resolve remaining pending gets with close signal
    const closeRequest: LiveRequest = {close: true};
    while (this.resolveFnFifoQueue.length > 0) {
      const resolve = this.resolveFnFifoQueue.shift()!;
      resolve(closeRequest);
    }

    // Remaining items in this.queue will be drained by subsequent get() calls.
  }

  /**
   * Sends a content object to the queue.
   * @param content The content to send.
   */
  sendContent(content: Content) {
    this.send({content});
  }

  /**
   * Sends a blob to the model in realtime mode.
   * @param blob The blob to send.
   */
  sendRealtime(blob: Blob) {
    this.send({blob});
  }

  /**
   * Sends an activity start signal to mark the beginning of user input.
   */
  sendActivityStart() {
    this.send({activityStart: {}});
  }

  /**
   * Sends an activity end signal to mark the end of user input.
   */
  sendActivityEnd() {
    this.send({activityEnd: {}});
  }

  /**
   * Implements the async iterator protocol.
   */
  async *
      [Symbol.asyncIterator](): AsyncGenerator<LiveRequest, void, undefined> {
    while (true) {
      const request = await this.get();
      yield request;
      if (request.close) {
        break;
      }
    }
  }
}
