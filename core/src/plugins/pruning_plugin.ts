/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {BasePruner} from '../context/pruners/base_pruner.js';
import {BaseTool} from '../tools/base_tool.js';
import {BasePlugin} from './base_plugin.js';

export interface PruningPluginRule {
  toolName: string;
  pruner: BasePruner;
}

export interface PruningPluginOptions {
  rules: PruningPluginRule[];
  sizeThreshold?: number;
}

export class PruningPlugin extends BasePlugin {
  constructor(private readonly options: PruningPluginOptions) {
    super('pruning_plugin');
  }

  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const rule = this.options.rules.find(
      (r) => r.toolName === params.tool.name,
    );
    if (!rule) {
      return undefined;
    }

    const rawResult = params.result as unknown;
    const size = this.getResponseSize(rawResult);
    const threshold = this.options.sizeThreshold ?? 0;

    if (size > threshold) {
      const pruned = rule.pruner.prune(rawResult);
      return pruned as Record<string, unknown>;
    }

    return undefined;
  }

  private getResponseSize(response: unknown): number {
    if (typeof response === 'string') {
      return response.length;
    }
    try {
      return JSON.stringify(response).length;
    } catch {
      return 0;
    }
  }
}
