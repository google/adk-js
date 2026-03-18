/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  loadSkillFromDir,
  parseSkillMdContent,
} from '../../src/skills/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Skills Loader', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'test-skill');

  beforeAll(async () => {
    await fs.mkdir(fixtureDir, {recursive: true});
    await fs.writeFile(
      path.join(fixtureDir, 'SKILL.md'),
      `---
name: test-skill
description: A test skill
---
# Test Instructions
Do something.`,
    );
  });

  afterAll(async () => {
    await fs.rm(path.join(__dirname, 'fixtures'), {
      recursive: true,
      force: true,
    });
  });

  it('should parse SKILL.md content', () => {
    const content = `---
name: list-files
description: List files
---
Body content`;
    const {frontmatter, body} = parseSkillMdContent(content);
    expect(frontmatter.name).toBe('list-files');
    expect(body).toBe('Body content');
  });

  it('should load skill from dir', async () => {
    const skill = await loadSkillFromDir(fixtureDir);
    expect(skill.name).toBe('test-skill');
    expect(skill.description).toBe('A test skill');
    expect(skill.instructions).toContain('Do something');
  });

  it('should throw error if name does not match dir', async () => {
    const invalidDir = path.join(__dirname, 'fixtures', 'invalid-skill');
    await fs.mkdir(invalidDir, {recursive: true});
    await fs.writeFile(
      path.join(invalidDir, 'SKILL.md'),
      `---
name: different-name
description: A test skill
---
Body`,
    );

    await expect(loadSkillFromDir(invalidDir)).rejects.toThrow(
      "Skill name 'different-name' does not match directory name 'invalid-skill'",
    );
  });
});
