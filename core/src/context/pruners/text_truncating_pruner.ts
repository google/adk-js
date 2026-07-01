/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {BasePruner} from './base_pruner.js';

export interface TextTruncatingPrunerOptions {
  maxLength?: number;
  maxLines?: number;
  keepLocation?: 'start' | 'end' | 'both';
  truncationMarker?: string;
}

const DEFAULT_MARKER = '...';
const DEFAULT_KEEP_LOCATION = 'both';

export class TextTruncatingPruner implements BasePruner {
  constructor(private readonly options: TextTruncatingPrunerOptions) {}

  prune(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    try {
      let pruned = value;
      const marker = this.options.truncationMarker ?? DEFAULT_MARKER;
      const keepLocation = this.options.keepLocation ?? DEFAULT_KEEP_LOCATION;

      if (this.options.maxLines !== undefined) {
        pruned = this.truncateLines(
          pruned,
          this.options.maxLines,
          keepLocation,
          marker,
        );
      }

      if (this.options.maxLength !== undefined) {
        pruned = this.truncateLength(
          pruned,
          this.options.maxLength,
          keepLocation,
          marker,
        );
      }

      return pruned;
    } catch (error) {
      logger.warn(
        'TextTruncatingPruner failed, returning original value:',
        error,
      );
      return value;
    }
  }

  private truncateLines(
    text: string,
    maxLines: number,
    keepLocation: 'start' | 'end' | 'both',
    marker: string,
  ): string {
    const lines = text.split('\n');
    if (lines.length <= maxLines) {
      return text;
    }

    if (maxLines <= 0) {
      return marker;
    }

    switch (keepLocation) {
      case 'start':
        return [...lines.slice(0, maxLines), marker].join('\n');
      case 'end':
        return [marker, ...lines.slice(lines.length - maxLines)].join('\n');
      case 'both':
        return [
          ...lines.slice(0, Math.ceil(maxLines / 2)),
          marker,
          ...lines.slice(lines.length - Math.floor(maxLines / 2)),
        ].join('\n');
      default:
        throw new Error(`Invalid keepLocation: ${keepLocation}`);
    }
  }

  private truncateLength(
    text: string,
    maxLength: number,
    keepLocation: 'start' | 'end' | 'both',
    marker: string,
  ): string {
    if (text.length <= maxLength) {
      return text;
    }

    if (maxLength < marker.length) {
      logger.warn(
        `maxLength (${maxLength}) is smaller than truncationMarker length (${marker.length}). Returning original text.`,
      );
      return text;
    }

    const budget = maxLength - marker.length;

    switch (keepLocation) {
      case 'start':
        return text.slice(0, budget) + marker;
      case 'end':
        return marker + text.slice(text.length - budget);
      case 'both':
        return (
          text.slice(0, Math.ceil(budget / 2)) +
          marker +
          text.slice(text.length - Math.floor(budget / 2))
        );
      default:
        throw new Error(`Invalid keepLocation: ${keepLocation}`);
    }
  }
}
