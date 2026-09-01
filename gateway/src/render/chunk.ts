/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Splitting a long answer into messages a channel will accept.
 *
 * Splitting is line-based, which gets paragraph and list boundaries right for
 * free — models emit newline-structured prose, so a naive character cut lands
 * mid-sentence far more often than it needs to.
 *
 * Code fences are tracked across the split: a fence that would straddle a
 * boundary is closed at the end of one message and reopened at the start of the
 * next, so neither half renders as broken markup.
 */

/** The marker that opens or closes a fenced code block. */
const FENCE = /^\s*```/;

/** Room to leave for a `\n```` we may have to append when inside a fence. */
const FENCE_CLOSE_COST = 4;

/**
 * Splits text into pieces no longer than `maxLength`.
 *
 * Returns a single piece when the text already fits, and never returns an empty
 * piece.
 */
export function chunkText(text: string, maxLength: number): string[] {
  if (maxLength <= 0) {
    throw new Error(`maxLength must be positive, got ${maxLength}`);
  }
  if (text.length <= maxLength) {
    return text.trim() ? [text] : [];
  }

  const chunks: string[] = [];
  const lines = text.split('\n');

  let current: string[] = [];
  let currentLength = 0;
  /** The opening fence line we are inside, if any. */
  let openFence: string | undefined;

  const budget = () => maxLength - (openFence ? FENCE_CLOSE_COST : 0);

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    let body = current.join('\n');
    if (openFence) {
      body += '\n```';
    }
    if (body.trim()) {
      chunks.push(body);
    }
    current = [];
    currentLength = 0;
    // Reopening happens below, so the next chunk starts inside the same fence.
  };

  for (const rawLine of lines) {
    // A single line longer than the budget has to be broken on its own terms.
    const pieces =
      rawLine.length > budget() ? splitLongLine(rawLine, budget()) : [rawLine];

    for (const line of pieces) {
      const cost = current.length === 0 ? line.length : line.length + 1;

      if (currentLength + cost > budget() && current.length > 0) {
        const reopen = openFence;
        flush();
        if (reopen) {
          current.push(reopen);
          currentLength = reopen.length;
        }
      }

      current.push(line);
      currentLength += current.length === 1 ? line.length : line.length + 1;

      if (FENCE.test(line)) {
        openFence = openFence ? undefined : line.trim();
      }
    }
  }

  flush();
  return chunks;
}

/**
 * Breaks a single over-long line, preferring a sentence end, then a word
 * boundary, and only then cutting mid-word.
 */
function splitLongLine(line: string, maxLength: number): string[] {
  const pieces: string[] = [];
  let rest = line;

  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const at = lastSentenceEnd(window) ?? lastWordEnd(window) ?? maxLength;
    pieces.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }

  if (rest) {
    pieces.push(rest);
  }
  return pieces;
}

/** The offset just past the last sentence terminator, if there is a late one. */
function lastSentenceEnd(window: string): number | undefined {
  const match = /[.!?]["')\]]?\s/g;
  let found: number | undefined;
  for (const hit of window.matchAll(match)) {
    found = hit.index + hit[0].length;
  }
  // Only worth using if it is not so early that it wastes most of the budget.
  return found !== undefined && found > window.length / 2 ? found : undefined;
}

/** The offset just past the last space, if there is a late one. */
function lastWordEnd(window: string): number | undefined {
  const at = window.lastIndexOf(' ');
  return at > window.length / 2 ? at + 1 : undefined;
}
