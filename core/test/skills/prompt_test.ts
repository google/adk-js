/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Skill} from '../../src/skills/models.js';
import {formatSkillsAsXml} from '../../src/skills/prompt.js';

describe('Skills Prompt Formatter', () => {
  it('should format empty skills list', () => {
    const xml = formatSkillsAsXml([]);
    expect(xml).toBe('<available_skills>\n</available_skills>');
  });

  it('should format skills list with one item', () => {
    const skill: Skill = {
      name: 'test-skill',
      description: 'A test skill',
      frontmatter: {
        name: 'test-skill',
        description: 'A test skill',
        metadata: {},
      },
      instructions: 'Instructions',
      resources: {references: {}, assets: {}, scripts: {}},
    };
    const xml = formatSkillsAsXml([skill]);
    expect(xml).toContain('<available_skills>');
    expect(xml).toContain('<name>test-skill</name>');
    expect(xml).toContain('<description>A test skill</description>');
    expect(xml).toContain('</available_skills>');
  });

  it('should escape HTML in content', () => {
    const skill: Skill = {
      name: 'test-<tag>',
      description: 'Desc & details',
      frontmatter: {
        name: 'test-<tag>',
        description: 'Desc & details',
        metadata: {},
      },
      instructions: 'Instructions',
      resources: {references: {}, assets: {}, scripts: {}},
    };
    const xml = formatSkillsAsXml([skill]);
    expect(xml).toContain('<name>test-&lt;tag&gt;</name>');
    expect(xml).toContain('<description>Desc &amp; details</description>');
  });
});
