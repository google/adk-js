/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic PRNG (mulberry32) for tests that stub `Math.random`. Samples
 * like `retry` and `loop_self` are model-free but use `Math.random`; seeding it
 * makes them reproducible. A seeded generator (rather than a constant) keeps the
 * engine's own random event-id generation varied, so ids don't collide.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
