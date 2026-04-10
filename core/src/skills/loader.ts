/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  Frontmatter,
  FrontmatterSchema,
  Resources,
  Script,
  Skill,
} from './skill.js';

const ALLOWED_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
  'compatibility',
]);

/**
 * Recursively loads files from a directory into a dictionary.
 */
async function loadDir(
  directoryPath: string,
): Promise<Record<string, string | Buffer>> {
  const files: Record<string, string | Buffer> = {};

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(directoryPath, fullPath);
        if (fullPath.includes('__pycache__')) continue;

        try {
          // Try reading as text
          const content = await fs.readFile(fullPath, 'utf-8');
          files[relativePath] = content;
        } catch (_e: unknown) {
          // Fallback to Buffer for binary files
          files[relativePath] = await fs.readFile(fullPath);
        }
      }
    }
  }

  try {
    const stats = await fs.stat(directoryPath);
    if (stats.isDirectory()) {
      await walk(directoryPath);
    }
  } catch (_e: unknown) {
    // ignore
  }

  return files;
}

/**
 * Parses SKILL.md from raw content string.
 */
export function parseSkillMdContent(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  if (!content.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }

  // Split into max 3 parts: empty before ---, frontmatter, body
  const parts = content.split('---', 3);
  if (parts.length < 3) {
    throw new Error('SKILL.md frontmatter not properly closed with ---');
  }

  const frontmatterStr = parts[1];
  const body = parts[2].trim();

  try {
    const parsed = yaml.load(frontmatterStr);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('SKILL.md frontmatter must be a YAML mapping');
    }
    const frontmatter = FrontmatterSchema.parse(parsed);

    return {frontmatter, body};
  } catch (e: unknown) {
    throw new Error(`Invalid YAML in frontmatter: ${(e as Error).message}`);
  }
}

/**
 * Load a complete skill from a directory.
 */
export async function loadSkillFromDir(skillDir: string): Promise<Skill> {
  const resolvedDir = path.resolve(skillDir);
  const skillMdPaths = [
    path.join(resolvedDir, 'SKILL.md'),
    path.join(resolvedDir, 'skill.md'),
  ];

  let skillMdPath = '';
  let content = '';

  for (const p of skillMdPaths) {
    try {
      content = await fs.readFile(p, 'utf-8');
      skillMdPath = p;
      break;
    } catch (_e: unknown) {
      // continue
    }
  }

  if (!skillMdPath) {
    throw new Error(`SKILL.md not found in '${skillDir}'.`);
  }

  const {frontmatter: parsed, body} = parseSkillMdContent(content);

  // Validate with Zod
  const frontmatter = FrontmatterSchema.parse(parsed);

  // Validate name matches directory name
  const dirName = path.basename(resolvedDir);
  if (dirName !== frontmatter.name) {
    throw new Error(
      `Skill name '${frontmatter.name}' does not match directory name '${dirName}'.`,
    );
  }

  const referencesDir = path.join(resolvedDir, 'references');
  const assetsDir = path.join(resolvedDir, 'assets');
  const scriptsDir = path.join(resolvedDir, 'scripts');

  const references = await loadDir(referencesDir);
  const assets = await loadDir(assetsDir);
  const rawScripts = await loadDir(scriptsDir);

  const scripts: Record<string, Script> = {};
  for (const [name, src] of Object.entries(rawScripts)) {
    if (typeof src === 'string') {
      scripts[name] = {src};
    }
  }

  const resources: Resources = {references, assets, scripts};

  return {
    frontmatter,
    instructions: body,
    resources,
  };
}

/**
 * Validate a skill directory without fully loading it.
 */
export async function validateSkillDir(skillDir: string): Promise<string[]> {
  const problems: string[] = [];
  const resolvedDir = path.resolve(skillDir);

  try {
    const stats = await fs.stat(resolvedDir);
    if (!stats.isDirectory()) {
      return [`'${skillDir}' is not a directory.`];
    }
  } catch (_e: unknown) {
    return [`Directory '${skillDir}' does not exist.`];
  }

  const skillMdPaths = [
    path.join(resolvedDir, 'SKILL.md'),
    path.join(resolvedDir, 'skill.md'),
  ];

  let skillMdPath = '';
  let content = '';

  for (const p of skillMdPaths) {
    try {
      content = await fs.readFile(p, 'utf-8');
      skillMdPath = p;
      break;
    } catch (_e: unknown) {
      // continue
    }
  }

  if (!skillMdPath) {
    return [`SKILL.md not found in '${skillDir}'.`];
  }

  try {
    const {frontmatter: parsed} = parseSkillMdContent(content);

    const keys = Object.keys(parsed);
    const unknown = keys.filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
    if (unknown.length > 0) {
      problems.push(
        `Unknown frontmatter fields: [${unknown.sort().join(', ')}]`,
      );
    }

    const result = FrontmatterSchema.safeParse(parsed);
    if (!result.success) {
      problems.push(`Frontmatter validation error: ${result.error.message}`);
      return problems;
    }

    const frontmatter = result.data;
    const dirName = path.basename(resolvedDir);
    if (dirName !== frontmatter.name) {
      problems.push(
        `Skill name '${frontmatter.name}' does not match directory name '${dirName}'.`,
      );
    }
  } catch (e: unknown) {
    problems.push((e as Error).message);
  }

  return problems;
}

/**
 * List skills in a local directory.
 */
export async function listSkillsInDir(
  skillsBasePath: string,
): Promise<Record<string, Skill>> {
  const resolvedPath = path.resolve(skillsBasePath);
  const skills: Record<string, Skill> = {};

  try {
    const entries = await fs.readdir(resolvedPath, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillDir = path.join(resolvedPath, entry.name);
        try {
          const skill = await loadSkillFromDir(skillDir);
          skills[skill.frontmatter.name] = skill;
        } catch (e) {
          // Skip invalid skills as per Python implementation
          console.warn(`Skipping invalid skill in '${skillDir}':`, e);
        }
      }
    }
  } catch (_e: unknown) {
    console.warn(`Skills base path '${skillsBasePath}' is not a directory.`);
  }

  return skills;
}
