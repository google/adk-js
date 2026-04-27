/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {logger} from '../utils/logger.js';
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

const IGNORED_DIRECTORIES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
  'coverage',
  'venv',
  '.venv',
  'env',
  '.env',
  '.git',
  '.vscode',
  '.idea',
]);

const IGNORED_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.pyd',
  '.tsbuildinfo',
  '.DS_Store',
]);

/**
 * Recursively loads files from a directory into a dictionary.
 *
 * @param directoryPath - The absolute or relative path of the directory to load.
 * @returns A promise that resolves to a dictionary where keys are relative file paths
 * and values are the file contents (as string for UTF-8 or Buffer otherwise).
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
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(directoryPath, fullPath);
        if (IGNORED_EXTENSIONS.has(path.extname(entry.name))) {
          continue;
        }

        const fileData = await fs.readFile(fullPath);

        try {
          files[relativePath] = fileData.toString('utf-8');
        } catch (_e: unknown) {
          files[relativePath] = fileData;
        }
      }
    }
  }

  try {
    const stats = await fs.stat(directoryPath);
    if (stats.isDirectory()) {
      await walk(directoryPath);
    }
  } catch (e: unknown) {
    logger.warn(
      `Failed to load directory '${directoryPath}': ${(e as Error).message}`,
    );
  }

  return files;
}

/**
 * Parses SKILL.md from a raw content string, extracting the YAML frontmatter and the body.
 *
 * @param content - The raw content of the SKILL.md file.
 * @returns An object containing the parsed frontmatter and the remaining markdown body.
 * @throws {Error} If the content is not properly formatted with YAML frontmatter.
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
 * Load a complete skill, including its instructions and resources, from a directory.
 *
 * @param skillDir - The path to the directory containing the skill definition.
 * @returns A promise that resolves to the fully loaded Skill object.
 */
export async function loadSkillFromDir(skillDir: string): Promise<Skill> {
  const resolvedDir = path.resolve(skillDir);
  const skill = await loadSkillFile(skillDir);

  const referencesDir = path.join(resolvedDir, 'references');
  const assetsDir = path.join(resolvedDir, 'assets');
  const scriptsDir = path.join(resolvedDir, 'scripts');

  const [references, assets, rawScripts] = await Promise.all([
    loadDir(referencesDir),
    loadDir(assetsDir),
    loadDir(scriptsDir),
  ]);

  const scripts: Record<string, Script> = {};
  for (const [name, src] of Object.entries(rawScripts)) {
    if (typeof src === 'string') {
      scripts[name] = {src};
    }
  }

  const resources: Resources = {references, assets, scripts};

  return {
    ...skill,
    resources,
  };
}

/**
 * Validates a skill directory structure and frontmatter without fully loading all resources.
 *
 * @param skillDir - The path to the skill directory to validate.
 * @returns A promise that resolves to an array of validation error messages, or an empty array if valid.
 */
export async function validateSkillDir(skillDir: string): Promise<string[]> {
  const problems: string[] = [];
  const resolvedDir = path.resolve(skillDir);

  let skill;
  try {
    skill = await loadSkillFile(resolvedDir);
  } catch (e: unknown) {
    return [(e as Error).message];
  }

  try {
    const keys = Object.keys(skill.frontmatter);
    const unknown = keys.filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
    if (unknown.length > 0) {
      problems.push(
        `Unknown frontmatter fields: [${unknown.sort().join(', ')}]`,
      );
    }

    const dirName = path.basename(resolvedDir);
    if (dirName !== skill.frontmatter.name) {
      problems.push(
        `Skill name '${skill.frontmatter.name}' does not match directory name '${dirName}'.`,
      );
    }
  } catch (e: unknown) {
    problems.push((e as Error).message);
  }

  return problems;
}

/**
 * Internal helper to load just the core skill definition (SKILL.md) from a directory.
 *
 * @param skillDir - The path to the skill directory.
 * @returns A promise that resolves to a Skill object containing only frontmatter and instructions.
 * @throws {Error} If the skill file cannot be found or parsed.
 */
async function loadSkillFile(skillDir: string): Promise<Skill> {
  const resolvedDir = path.resolve(skillDir);
  let skillMdPath = '';
  let content = '';

  try {
    const entries = await fs.readdir(resolvedDir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        const p = path.join(resolvedDir, entry.name);
        try {
          content = await fs.readFile(p, 'utf-8');
          skillMdPath = p;
          break;
        } catch (_e: unknown) {
          // continue
        }
      }
    }
  } catch (e: unknown) {
    logger.warn(
      `Failed to load directory '${skillDir}': ${(e as Error).message}`,
    );
  }

  if (!skillMdPath) {
    throw new Error(
      `SKILL.md (or any case variation like skill.md) not found in '${skillDir}'.`,
    );
  }

  const {frontmatter: parsed, body} = parseSkillMdContent(content);
  const frontmatter = FrontmatterSchema.parse(parsed);
  const dirName = path.basename(resolvedDir);
  if (dirName !== frontmatter.name) {
    throw new Error(
      `Skill name '${frontmatter.name}' does not match directory name '${dirName}'.`,
    );
  }

  return {
    frontmatter,
    instructions: body,
  };
}

/**
 * Loads all skills located within subdirectories of a given base path.
 *
 * @param skillsBasePath - The base directory containing individual skill subdirectories.
 * @returns A promise that resolves to a map of skill names to their corresponding Skill objects.
 */
export async function loadAllSkillsInDir(
  skillsBasePath: string,
): Promise<Record<string, Skill>> {
  const resolvedPath = path.resolve(skillsBasePath);
  const skills: Record<string, Skill> = {};

  async function scanDir(currentDir: string) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, {withFileTypes: true});
    } catch (_e: unknown) {
      return;
    }

    let isSkillDir = false;
    if (currentDir !== resolvedPath) {
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
          isSkillDir = true;
          break;
        }
      }
    }

    if (isSkillDir) {
      try {
        const skill = await loadSkillFromDir(currentDir);
        skills[skill.frontmatter.name] = skill;
      } catch (e) {
        logger.warn(`Skipping invalid skill in '${currentDir}':`, e);
      }
    } else {
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) {
            continue;
          }
          await scanDir(path.join(currentDir, entry.name));
        }
      }
    }
  }

  try {
    await fs.readdir(resolvedPath);
    await scanDir(resolvedPath);
  } catch (e: unknown) {
    logger.warn(`Skills base path '${skillsBasePath}' is not a directory.`, e);
  }

  return skills;
}
