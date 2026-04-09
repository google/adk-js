/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

export const SNAKE_OR_KEBAB_NAME_PATTERN =
  /^([a-z0-9]+(-[a-z0-9]+)*|[a-z0-9]+(_[a-z0-9]+)*)$/;

/**
 * Schema and Type for Skill Frontmatter metadata.
 */
export const FrontmatterSchema = z.preprocess(
  (data) => {
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('allowed-tools' in obj && !('allowedTools' in obj)) {
        return {
          ...obj,
          allowedTools: obj['allowed-tools'],
        };
      }
    }
    return data;
  },
  z
    .object({
      name: z
        .string()
        .regex(SNAKE_OR_KEBAB_NAME_PATTERN, {
          message:
            'name must be lowercase kebab-case (a-z, 0-9, hyphens) or snake_case (a-z, 0-9, underscores), with no leading, trailing, or consecutive delimiters. Mixing hyphens and underscores is not allowed.',
        })
        .max(64),
      description: z.string().min(1).max(1024),
      license: z.string().optional(),
      compatibility: z.string().max(500).optional(),
      'allowed-tools': z.string().optional(),
      metadata: z
        .record(z.string(), z.any())
        .default({})
        .refine(
          (data) => {
            if ('adk_additional_tools' in data) {
              return (
                Array.isArray(data.adk_additional_tools) &&
                data.adk_additional_tools.every(
                  (item) => typeof item === 'string',
                )
              );
            }
            return true;
          },
          {
            message: 'adk_additional_tools must be a list of strings',
          },
        ),
    })
    .loose(),
);

export interface Frontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Wrapper for script content.
 */
export interface Script {
  src: string;
}

/**
 * L3 skill content: additional instructions, assets, and scripts.
 */
export interface Resources {
  references?: Record<string, string | Buffer>;
  assets?: Record<string, string | Buffer>;
  scripts?: Record<string, Script>;
}

/**
 * Complete skill representation including frontmatter, instructions, and resources.
 */
export interface Skill {
  frontmatter: Frontmatter;
  instructions: string;
  resources?: Resources;
}
