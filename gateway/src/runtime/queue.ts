/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializing work per session.
 *
 * Two messages arriving in one chat a moment apart would otherwise start two
 * invocations against the same session, which interleave their appended events
 * and corrupt the transcript. Lanes are keyed on the session rather than the
 * conversation so that a thread-per-session channel still runs its threads in
 * parallel.
 */

/** What to do when a message arrives while its session is already busy. */
export type BusyPolicy =
  /** Wait for the running turn, then run. The safe default. */
  | 'queue'
  /** Discard anything already waiting, keeping only the newest. */
  | 'coalesce'
  /** Discard the new message. */
  | 'drop'
  /** Abort the running turn and run the new message instead. */
  | 'interrupt';

/** How a submitted task ended up. */
export type RunOutcome =
  /** It ran to completion. */
  | 'ran'
  /** It never ran: the lane was busy and the policy said to discard it. */
  | 'dropped'
  /** It never ran: a newer task replaced it while it waited. */
  | 'superseded';

/**
 * A unit of work. Receives a signal that is aborted if the task is interrupted
 * or the queue is shut down; long-running work should pass it on.
 */
export type QueueTask = (signal: AbortSignal) => Promise<void>;

/** Options for {@link SessionQueue}. */
export interface SessionQueueOptions {
  /** What to do when a lane is busy. Defaults to `'queue'`. */
  onBusy?: BusyPolicy;
  /** How many tasks may wait in one lane. Defaults to 8. */
  maxQueued?: number;
}

interface PendingTask {
  task: QueueTask;
  resolve: (outcome: RunOutcome) => void;
  reject: (error: unknown) => void;
}

interface RunningTask {
  controller: AbortController;
  done: Promise<void>;
}

interface Lane {
  running?: RunningTask;
  pending: PendingTask[];
}

const DEFAULT_MAX_QUEUED = 8;

/** A set of FIFO lanes, one per key, each running at most one task at a time. */
export class SessionQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly onBusy: BusyPolicy;
  private readonly maxQueued: number;

  constructor(options: SessionQueueOptions = {}) {
    this.onBusy = options.onBusy ?? 'queue';
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  /** How many lanes currently hold work. Exposed for tests and metrics. */
  get activeLanes(): number {
    return this.lanes.size;
  }

  /**
   * Submits work to a lane.
   *
   * Resolves with how the task ended up, or rejects with whatever the task
   * threw. A task that is dropped or superseded resolves without running and
   * without error — being too busy is not a failure.
   */
  run(key: string, task: QueueTask): Promise<RunOutcome> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = {pending: []};
      this.lanes.set(key, lane);
    }

    if (lane.running) {
      switch (this.onBusy) {
        case 'drop':
          this.collectIfIdle(key, lane);
          return Promise.resolve<RunOutcome>('dropped');

        case 'interrupt':
          // The next task starts only once the aborted one has actually
          // returned, so the two never touch the session at the same time.
          lane.running.controller.abort();
          break;

        case 'coalesce':
          for (const waiting of lane.pending) {
            waiting.resolve('superseded');
          }
          lane.pending.length = 0;
          break;

        case 'queue':
          if (lane.pending.length >= this.maxQueued) {
            return Promise.resolve<RunOutcome>('dropped');
          }
          break;

        default: {
          const unreachable: never = this.onBusy;
          throw new Error(`Unknown busy policy: ${String(unreachable)}`);
        }
      }
    }

    const laneRef = lane;
    return new Promise<RunOutcome>((resolve, reject) => {
      laneRef.pending.push({task, resolve, reject});
      this.pump(key);
    });
  }

  /** Resolves once every lane is empty. */
  async drain(): Promise<void> {
    // Draining one lane can feed another (a task may enqueue more work), so
    // loop until a full pass finds nothing outstanding.
    while (this.lanes.size > 0) {
      const running = [...this.lanes.values()]
        .map((lane) => lane.running?.done)
        .filter((done): done is Promise<void> => done !== undefined);
      if (running.length === 0) {
        break;
      }
      await Promise.allSettled(running);
    }
  }

  /** Aborts every running task and discards everything waiting. */
  abortAll(): void {
    for (const [key, lane] of this.lanes) {
      lane.running?.controller.abort();
      for (const waiting of lane.pending) {
        waiting.resolve('dropped');
      }
      lane.pending.length = 0;
      this.collectIfIdle(key, lane);
    }
  }

  /** Starts the next task in a lane, if one can start. */
  private pump(key: string): void {
    const lane = this.lanes.get(key);
    if (!lane || lane.running || lane.pending.length === 0) {
      return;
    }

    const next = lane.pending.shift();
    if (!next) {
      return;
    }

    const controller = new AbortController();
    // Registered before the task starts: a task that finishes synchronously
    // would otherwise clear a slot that had not been filled yet.
    const running: RunningTask = {controller, done: Promise.resolve()};
    lane.running = running;

    running.done = (async () => {
      try {
        await next.task(controller.signal);
        next.resolve('ran');
      } catch (error) {
        next.reject(error);
      } finally {
        if (lane.running === running) {
          lane.running = undefined;
        }
        if (lane.pending.length > 0) {
          this.pump(key);
        } else {
          this.collectIfIdle(key, lane);
        }
      }
    })();
  }

  /**
   * Forgets an idle lane.
   *
   * Lanes are keyed by session id, so without this the map grows by one entry
   * per conversation the bot has ever seen and never shrinks.
   */
  private collectIfIdle(key: string, lane: Lane): void {
    if (!lane.running && lane.pending.length === 0) {
      this.lanes.delete(key);
    }
  }
}
