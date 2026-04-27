/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {formatSkillsAsXml} from '../../src/skills/prompt.js';
import {Frontmatter, Skill} from '../../src/skills/skill.js';

describe('prompt', () => {
  describe('formatSkillsAsXml', () => {
    it('returns empty tags for empty skills list', () => {
      expect(formatSkillsAsXml([])).toBe(
        '<available_skills>\n</available_skills>',
      );
    });

    it('formats a single skill from frontmatter', () => {
      const skills: Frontmatter[] = [
        {name: 'test-skill', description: 'A test skill'},
      ];
      const expected = `<available_skills>
  <skill>
    <name>test-skill</name>
    <description>A test skill</description>
  </skill>
</available_skills>`;
      expect(formatSkillsAsXml(skills)).toBe(expected);
    });

    it('formats multiple skills', () => {
      const skills: Frontmatter[] = [
        {name: 'skill-1', description: 'Desc 1'},
        {name: 'skill-2', description: 'Desc 2'},
      ];
      const expected = `<available_skills>
  <skill>
    <name>skill-1</name>
    <description>Desc 1</description>
  </skill>
  <skill>
    <name>skill-2</name>
    <description>Desc 2</description>
  </skill>
</available_skills>`;
      expect(formatSkillsAsXml(skills)).toBe(expected);
    });

    it('formats skills passed as Skill objects', () => {
      const skills = [
        {
          frontmatter: {name: 'skill-1', description: 'Desc 1'},
          instructions: 'Instructions 1',
          resources: {},
        } as Skill,
      ];
      const expected = `<available_skills>
  <skill>
    <name>skill-1</name>
    <description>Desc 1</description>
  </skill>
</available_skills>`;
      expect(formatSkillsAsXml(skills)).toBe(expected);
    });

    it('escapes HTML entities in name and description', () => {
      const skills: Frontmatter[] = [
        {
          name: 'dangerous<name>',
          description: 'dangerous&description"with\'quotes',
        },
      ];
      const expected = `<available_skills>
  <skill>
    <name>dangerous&lt;name&gt;</name>
    <description>dangerous&amp;description&quot;with&#039;quotes</description>
  </skill>
</available_skills>`;
      expect(formatSkillsAsXml(skills)).toBe(expected);
    });
  });
});
