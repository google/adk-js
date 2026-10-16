/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  loadAllSkillsInDir,
  loadSkillFromDir,
  loadSkillFromZipBuffer,
  parseSkillMdContent,
  validateSkillDir,
} from '../../src/skills/loader.js';

describe('loader', () => {
  describe('parseSkillMdContent', () => {
    it('parses valid skill content', () => {
      const content = `---
name: test-skill
description: A test skill
---
Body content goes here.
Lines can continue.`;

      const result = parseSkillMdContent(content);
      expect(result.frontmatter).toEqual({
        name: 'test-skill',
        description: 'A test skill',
        metadata: {},
      });
      expect(result.body).toBe('Body content goes here.\nLines can continue.');
    });

    it('throws error if content does not start with ---', () => {
      const content = `name: test-skill
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'SKILL.md must start with YAML frontmatter (---)',
      );
    });

    it('throws error if frontmatter is not properly closed', () => {
      const content = `---
name: test-skill
description: A test skill`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'SKILL.md frontmatter not properly closed with ---',
      );
    });

    it('throws error if frontmatter is not a YAML mapping', () => {
      const content = `---
- item1
- item2
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'Invalid YAML in frontmatter:',
      );
    });

    it('throws error on invalid YAML', () => {
      const content = `---
name: test-skill
description: A test skill
invalid: [
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'Invalid YAML in frontmatter:',
      );
    });

    it('handles empty body', () => {
      const content = `---
name: test-skill
description: A test skill
---`;
      const result = parseSkillMdContent(content);
      expect(result.frontmatter).toEqual({
        name: 'test-skill',
        description: 'A test skill',
        metadata: {},
      });
      expect(result.body).toBe('');
    });

    it('handles extra newlines in body', () => {
      const content = `---
name: test-skill
description: A test skill
---


Body with newlines
`;
      const result = parseSkillMdContent(content);
      expect(result.body).toBe('Body with newlines');
    });

    it('handles tables in body', () => {
      const body = `Body with table

| Column 1 | Column 2 |
|---|---|
| Cell 1 | Cell 2 |`;
      const content = `---
name: test-skill
description: A test skill
---
${body}
`;
      const result = parseSkillMdContent(content);
      expect(result.body).toBe(body);
    });
  });

  describe('loadSkillFromDir', () => {
    let tempDir: string;

    it('loads a valid skill from a directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions content`,
      );

      const skill = await loadSkillFromDir(skillDir);
      expect(skill.frontmatter.name).toBe('test-skill');
      expect(skill.instructions).toBe('Instructions content');
      expect(skill.resources?.references).toEqual({});
      expect(skill.resources?.assets).toEqual({});
      expect(skill.resources?.scripts).toEqual({});

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.each(['SKILL.md', 'skill.md', 'Skill.md', 'sKiLl.Md'])(
      'loads a valid skill with %s file name',
      async (fileName) => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const skillDir = path.join(tempDir, 'test-skill');
        await fs.mkdir(skillDir);

        await fs.writeFile(
          path.join(skillDir, fileName),
          `---
name: test-skill
description: A test skill
---
Instructions content`,
        );

        const skill = await loadSkillFromDir(skillDir);
        expect(skill.frontmatter.name).toBe('test-skill');
        expect(skill.instructions).toBe('Instructions content');

        await fs.rm(tempDir, {recursive: true, force: true});
      },
    );

    it('throws error if SKILL.md not found', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await expect(loadSkillFromDir(skillDir)).rejects.toThrow(
        /SKILL\.md \(or any case variation like skill\.md\) not found/,
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('throws error if skill name does not match directory name', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'wrong-name');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      await expect(loadSkillFromDir(skillDir)).rejects.toThrow(
        /does not match directory name/,
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('loads resources if they exist', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      await fs.mkdir(path.join(skillDir, 'references'));
      await fs.mkdir(path.join(skillDir, 'assets'));
      await fs.mkdir(path.join(skillDir, 'scripts'));

      await fs.writeFile(
        path.join(skillDir, 'references', 'ref.txt'),
        'reference content',
      );
      await fs.writeFile(
        path.join(skillDir, 'assets', 'logo.png'),
        'binary content',
      );
      await fs.writeFile(
        path.join(skillDir, 'scripts', 'run.sh'),
        'echo hello',
      );

      const skill = await loadSkillFromDir(skillDir);
      expect(skill.resources?.references?.['ref.txt']).toBe(
        'reference content',
      );
      // File is named .png but contents are valid UTF-8 text, so it stays a string.
      expect(skill.resources?.assets?.['logo.png']).toBe('binary content');
      expect(skill.resources?.scripts?.['run.sh']).toEqual({src: 'echo hello'});

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('keeps non-UTF-8 binary assets as Buffer', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);
      await fs.mkdir(path.join(skillDir, 'assets'));

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      // Minimal PNG signature bytes — invalid UTF-8, must not be stringified.
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8,
      ]);
      await fs.writeFile(path.join(skillDir, 'assets', 'logo.png'), pngBytes);

      const skill = await loadSkillFromDir(skillDir);
      const asset = skill.resources?.assets?.['logo.png'];
      expect(Buffer.isBuffer(asset)).toBe(true);
      expect(asset).toEqual(pngBytes);

      await fs.rm(tempDir, {recursive: true, force: true});
    });
  });

  describe('validateSkillDir', () => {
    let tempDir: string;

    it('returns no problems for a valid skill directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems).toEqual([]);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.each(['SKILL.md', 'skill.md', 'Skill.md', 'sKiLl.Md'])(
      'returns no problems for a valid skill directory with %s file name',
      async (fileName) => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const skillDir = path.join(tempDir, 'test-skill');
        await fs.mkdir(skillDir);

        await fs.writeFile(
          path.join(skillDir, fileName),
          `---
name: test-skill
description: A test skill
---
Instructions`,
        );

        const problems = await validateSkillDir(skillDir);
        expect(problems).toEqual([]);

        await fs.rm(tempDir, {recursive: true, force: true});
      },
    );

    it('returns problem if directory does not exist', async () => {
      const testPath = '/non/existent/path';
      const problems = await validateSkillDir(testPath);
      expect(problems.length).toBe(1);
      expect(problems[0]).toBe(
        `Directory '${path.resolve(testPath)}' does not exist.`,
      );
    });

    it('returns problem if path is a file, not a directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const filePath = path.join(tempDir, 'test-skill');
      await fs.writeFile(filePath, 'not a directory');

      const problems = await validateSkillDir(filePath);
      expect(problems.length).toBe(1);
      expect(problems[0]).toBe(
        `'${path.resolve(filePath)}' is not a directory.`,
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem if SKILL.md missing', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain(
        'SKILL.md (or any case variation like skill.md) not found',
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem for unknown frontmatter fields', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
unknown_field: value
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBeGreaterThan(0);
      expect(
        problems.some((p) => p.includes('Unknown frontmatter fields')),
      ).toBe(true);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.each(['allowed-tools', 'allowedTools'])(
      'returns no problems for a skill declaring %s',
      async (key) => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const skillDir = path.join(tempDir, 'test-skill');
        await fs.mkdir(skillDir);

        await fs.writeFile(
          path.join(skillDir, 'SKILL.md'),
          `---
name: test-skill
description: A test skill
${key}: "some-tool-*"
---
Instructions`,
        );

        const problems = await validateSkillDir(skillDir);
        expect(problems).toEqual([]);

        await fs.rm(tempDir, {recursive: true, force: true});
      },
    );

    it('omits the allowedTools alias from the unknown fields message', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
allowed-tools: "some-tool-*"
unknown_field: value
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems).toEqual(['Unknown frontmatter fields: [unknown_field]']);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem for invalid frontmatter', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBeGreaterThan(0);
      expect(
        problems.some((p) => p.includes('Invalid YAML in frontmatter:')),
      ).toBe(true);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem if name does not match directory name', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'wrong-name');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain('does not match directory name');

      await fs.rm(tempDir, {recursive: true, force: true});
    });
  });

  describe('loadAllSkillsInDir', () => {
    let tempDir: string;

    it('lists valid skills in a directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const skill1Dir = path.join(tempDir, 'skill-1');
      await fs.mkdir(skill1Dir);
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill-1
description: Skill 1
---
Instructions`,
      );

      const skill2Dir = path.join(tempDir, 'skill-2');
      await fs.mkdir(skill2Dir);
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: skill-2
description: Skill 2
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(2);
      expect(skills['skill-1']).toBeDefined();
      expect(skills['skill-2']).toBeDefined();
      expect(skills['skill-1'].frontmatter.name).toBe('skill-1');

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('skips invalid skills and continues', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const validSkillDir = path.join(tempDir, 'valid-skill');
      await fs.mkdir(validSkillDir);
      await fs.writeFile(
        path.join(validSkillDir, 'SKILL.md'),
        `---
name: valid-skill
description: Valid Skill
---
Instructions`,
      );

      const invalidSkillDir = path.join(tempDir, 'invalid-skill');
      await fs.mkdir(invalidSkillDir);
      await fs.writeFile(
        path.join(invalidSkillDir, 'SKILL.md'),
        `---
name: wrong-name
description: Invalid Skill
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(1);
      expect(skills['valid-skill']).toBeDefined();
      expect(skills['wrong-name']).toBeUndefined();

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('handles non-existent directory gracefully', async () => {
      const skills = await loadAllSkillsInDir('/non/existent/path');
      expect(skills).toEqual({});
    });

    it('loads skills from nested subdirectories', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const subdir1 = path.join(tempDir, 'subdir1');
      await fs.mkdir(subdir1);

      const skill1Dir = path.join(subdir1, 'skill-1');
      await fs.mkdir(skill1Dir);
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill-1
description: Skill 1
---
Instructions`,
      );

      const skill2Dir = path.join(subdir1, 'skill-2');
      await fs.mkdir(skill2Dir);
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: skill-2
description: Skill 2
---
Instructions`,
      );

      const subdir2 = path.join(tempDir, 'subdir2');
      await fs.mkdir(subdir2);

      const skill3Dir = path.join(subdir2, 'skill-3');
      await fs.mkdir(skill3Dir);
      await fs.writeFile(
        path.join(skill3Dir, 'SKILL.md'),
        `---
name: skill-3
description: Skill 3
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(3);
      expect(skills['skill-1']).toBeDefined();
      expect(skills['skill-2']).toBeDefined();
      expect(skills['skill-3']).toBeDefined();

      await fs.rm(tempDir, {recursive: true, force: true});
    });
  });

  describe('loadSkillFromZipBuffer', () => {
    const validSkillMd = `---
name: test-skill
description: A test skill
---
Instruction body`;

    /**
     * Builds an archive containing a member with a raw, unsanitised
     * `entryName`. `AdmZip.addFile` canonicalises the names it is given
     * (`'../evil.txt'` is stored as `'evil.txt'`), so the entry is added under a
     * placeholder name and renamed afterwards.
     */
    function createZipWithRawEntryName(entryName: string): Buffer {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(validSkillMd, 'utf-8'));
      zip.addFile('placeholder.txt', Buffer.from('x', 'utf-8'));
      const placeholder = zip
        .getEntries()
        .find((e) => e.entryName === 'placeholder.txt');
      if (!placeholder) {
        expect.fail('fixture setup failed: placeholder.txt was not added');
      }
      placeholder.entryName = entryName;
      return zip.toBuffer();
    }

    function createZipWithSkillMd(skillMd: string): Buffer {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf-8'));
      return zip.toBuffer();
    }

    function createZipWithSkillName(name: string): Buffer {
      return createZipWithSkillMd(
        `---\nname: ${name}\ndescription: A test skill\n---\nBody`,
      );
    }

    it('loads a benign archive with all resource trees', () => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(validSkillMd, 'utf-8'));
      zip.addFile('references/ref1.md', Buffer.from('ref content', 'utf-8'));
      zip.addFile('assets/a.txt', Buffer.from('asset content', 'utf-8'));
      zip.addFile('scripts/run.sh', Buffer.from('echo hello', 'utf-8'));

      const skill = loadSkillFromZipBuffer(zip.toBuffer());

      expect(skill.frontmatter.name).toBe('test-skill');
      expect(skill.instructions).toBe('Instruction body');
      expect(skill.resources?.references?.['ref1.md']).toBe('ref content');
      expect(skill.resources?.assets?.['a.txt']).toBe('asset content');
      expect(skill.resources?.scripts?.['run.sh']?.src).toBe('echo hello');
    });

    it('keeps non-UTF-8 binary assets as Buffer', () => {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8,
      ]);
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(validSkillMd, 'utf-8'));
      zip.addFile('assets/logo.png', pngBytes);

      const skill = loadSkillFromZipBuffer(zip.toBuffer());
      const asset = skill.resources?.assets?.['logo.png'];
      expect(Buffer.isBuffer(asset)).toBe(true);
      expect(asset).toEqual(pngBytes);
    });

    it.each([
      '/etc/passwd',
      '../evil.txt',
      'references/../../esc.txt',
      'scripts/..',
      'scripts\\..\\..\\pwned.txt',
    ])('rejects the whole archive for the dangerous entry %s', (entryName) => {
      expect(() =>
        loadSkillFromZipBuffer(createZipWithRawEntryName(entryName)),
      ).toThrow(`Dangerous zip entry ignored: ${entryName}`);
    });

    it('reports the dangerous entry even when SKILL.md is absent', () => {
      const zip = new AdmZip();
      zip.addFile('placeholder.txt', Buffer.from('x', 'utf-8'));
      const placeholder = zip.getEntries()[0];
      placeholder.entryName = '../evil.txt';

      expect(() => loadSkillFromZipBuffer(zip.toBuffer())).toThrow(
        'Dangerous zip entry ignored: ../evil.txt',
      );
    });

    it.each(['../evil', 'a/b', '..'])(
      'rejects the non-bare skill name %s',
      (name) => {
        expect(() =>
          loadSkillFromZipBuffer(createZipWithSkillName(name)),
        ).toThrow(`Invalid skill name in SKILL.md: ${name}`);
      },
    );

    it('rejects a skill name that is not a string', () => {
      expect(() =>
        loadSkillFromZipBuffer(createZipWithSkillName('123')),
      ).toThrow('Invalid skill name in SKILL.md: 123');
    });

    it('rejects frontmatter with no name', () => {
      const zipBuffer = createZipWithSkillMd(
        '---\ndescription: A test skill\n---\nBody',
      );
      expect(() => loadSkillFromZipBuffer(zipBuffer)).toThrow(
        "SKILL.md frontmatter must contain 'name'",
      );
    });

    it('reports a YAML sequence as a non-mapping, not as a missing name', () => {
      const zipBuffer = createZipWithSkillMd(
        '---\n- item1\n- item2\n---\nBody',
      );
      expect(() => loadSkillFromZipBuffer(zipBuffer)).toThrow(
        'Invalid YAML in frontmatter: SKILL.md frontmatter must be a YAML mapping',
      );
    });

    it('still reports a missing SKILL.md in a benign archive', () => {
      const zip = new AdmZip();
      zip.addFile('references/ref1.md', Buffer.from('ref content', 'utf-8'));

      expect(() => loadSkillFromZipBuffer(zip.toBuffer())).toThrow(
        'SKILL.md not found in zipped filesystem.',
      );
    });
  });
});
