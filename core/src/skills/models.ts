/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Schema and Type for Skill Frontmatter metadata.
 */
export const FrontmatterSchema = z
  .object({
    /** Skill name in lowercase kebab-case. Max 64 chars. */
    name: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
        message:
          'name must be lowercase kebab-case (a-z, 0-9, hyphens), with no leading, trailing, or consecutive hyphens',
      })
      .max(64),

    /** Description of what the skill does. Max 1024 chars. */
    description: z.string().min(1).max(1024),

    /** License information. Optional. */
    license: z.string().optional(),

    /** Compatibility requirements. Max 500 chars. Optional. */
    compatibility: z.string().max(500).optional(),

    /** Space-delimited list of pre-approved tools. Optional. */
    'allowed-tools': z.string().optional(),

    /** Arbitrary metadata. */
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
  .passthrough();

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

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
  references: Record<string, string | Buffer>;
  assets: Record<string, string | Buffer>;
  scripts: Record<string, Script>;
}

/**
 * Complete skill representation including frontmatter, instructions, and resources.
 */
export interface Skill {
  name: string;
  description: string;
  frontmatter: Frontmatter;
  instructions: string;
  resources: Resources;
}
