/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill} from './skill.js';

/**
 * Interface for a skill registry.
 */
export interface SkillRegistry {
  /**
   * Fetches a skill from the registry.
   *
   * @param name The name of the skill.
   * @returns A Promise resolving to a Skill object.
   */
  getSkill(name: string): Promise<Skill>;

  /**
   * Searches for skills in the registry.
   *
   * @param query The search query.
   * @returns A Promise resolving to a list of Frontmatter objects for discovery.
   */
  searchSkills(query: string): Promise<Frontmatter[]>;

  /**
   * Returns the description for the search_skills tool.
   */
  searchToolDescription?(): string | undefined;
}
