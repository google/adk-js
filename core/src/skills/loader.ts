/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import {isUtf8} from 'node:buffer';
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
  // Camel-case alias: FrontmatterSchema's preprocessor derives `allowedTools`
  // from `allowed-tools`, and `.loose()` passes either spelling through.
  'allowedTools',
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
 * Decodes skill resource bytes as UTF-8 text when valid, otherwise keeps the
 * raw Buffer.
 *
 * `Buffer.prototype.toString('utf-8')` never throws on invalid sequences — it
 * substitutes U+FFFD — so callers must check validity before decoding.
 */
function decodeSkillFileContent(data: Buffer): string | Buffer {
  return isUtf8(data) ? data.toString('utf-8') : data;
}

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
        files[relativePath] = decodeSkillFileContent(fileData);
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
 * Splits SKILL.md into its raw, unvalidated YAML frontmatter mapping and its body.
 *
 * @param content - The raw content of the SKILL.md file.
 * @returns An object containing the raw frontmatter mapping and the remaining markdown body.
 * @throws {Error} If the content is not properly formatted with YAML frontmatter.
 */
function parseFrontmatterYaml(content: string): {
  raw: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }

  // Split into at least 3 parts: empty before ---, frontmatter, body
  const parts = content.split('---');
  if (parts.length < 3) {
    throw new Error('SKILL.md frontmatter not properly closed with ---');
  }

  const frontmatterStr = parts[1];
  const body = parts
    .filter((_, i) => i >= 2)
    .join('---')
    .trim();

  try {
    const parsed = yaml.load(frontmatterStr);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('SKILL.md frontmatter must be a YAML mapping');
    }
    return {raw: parsed as Record<string, unknown>, body};
  } catch (e: unknown) {
    throw new Error(`Invalid YAML in frontmatter: ${(e as Error).message}`);
  }
}

/**
 * Validates a raw frontmatter mapping against {@link FrontmatterSchema}.
 *
 * @param raw - The raw frontmatter mapping produced by {@link parseFrontmatterYaml}.
 * @returns The validated and normalized frontmatter.
 * @throws {Error} If the mapping does not satisfy the schema.
 */
function validateFrontmatter(raw: Record<string, unknown>): Frontmatter {
  try {
    return FrontmatterSchema.parse(raw);
  } catch (e: unknown) {
    throw new Error(`Invalid YAML in frontmatter: ${(e as Error).message}`);
  }
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
  const {raw, body} = parseFrontmatterYaml(content);
  return {frontmatter: validateFrontmatter(raw), body};
}

/**
 * Checks whether a zip member name attempts to escape the extraction root (zip
 * slip), mirroring adk-python's `_load_skill_from_zip_bytes`. This is a
 * name-shape check on archive metadata, not a sandbox: it says nothing about
 * symlinks.
 */
function isDangerousZipEntryName(entryName: string): boolean {
  if (path.posix.isAbsolute(entryName) || path.win32.isAbsolute(entryName)) {
    return true;
  }
  return entryName.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * Checks that a skill name is a single bare path segment, mirroring
 * adk-python's `pathlib.Path(name).name != name`. '.' and '..' are rejected
 * explicitly because `path.basename('..') === '..'` whereas
 * `pathlib.Path('..').name === ''`.
 */
function isBareSkillName(name: string): boolean {
  return name !== '.' && name !== '..' && path.basename(name) === name;
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

/**
 * Loads a complete skill directly from in-memory zip file buffer.
 *
 * The whole archive is rejected if any member name escapes the extraction
 * root, and the skill name must be a bare path segment.
 *
 * @param zipBuffer - The raw Buffer of the zip file containing the skill.
 * @returns A Skill object with all components loaded.
 * @throws {Error} If a member name is a traversal path, if SKILL.md is missing,
 * or if the skill name is missing or is not a bare path segment.
 */
export function loadSkillFromZipBuffer(zipBuffer: Buffer): Skill {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (isDangerousZipEntryName(entry.entryName)) {
      throw new Error(`Dangerous zip entry ignored: ${entry.entryName}`);
    }
  }

  let skillMdContent = '';
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName.toLowerCase() === 'skill.md') {
      skillMdContent = entry.getData().toString('utf-8');
      break;
    }
  }

  if (!skillMdContent) {
    throw new Error('SKILL.md not found in zipped filesystem.');
  }

  const {raw, body} = parseFrontmatterYaml(skillMdContent);
  const skillName = raw['name'];
  if (!skillName) {
    throw new Error("SKILL.md frontmatter must contain 'name'");
  }
  if (typeof skillName !== 'string' || !isBareSkillName(skillName)) {
    throw new Error(`Invalid skill name in SKILL.md: ${String(skillName)}`);
  }
  const frontmatter = validateFrontmatter(raw);

  const references: Record<string, string | Buffer> = {};
  const assets: Record<string, string | Buffer> = {};
  const scripts: Record<string, Script> = {};

  function loadZipDir(prefix: string): Record<string, string | Buffer> {
    const res: Record<string, string | Buffer> = {};
    const normPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (entry.entryName.startsWith(normPrefix)) {
        if (entry.entryName.includes('__pycache__')) continue;
        const relativePath = entry.entryName.substring(normPrefix.length);
        if (!relativePath) continue;
        const data = entry.getData();
        res[relativePath] = decodeSkillFileContent(data);
      }
    }
    return res;
  }

  const refFiles = loadZipDir('references');
  for (const [key, val] of Object.entries(refFiles)) {
    references[key] = val;
  }

  const assetFiles = loadZipDir('assets');
  for (const [key, val] of Object.entries(assetFiles)) {
    assets[key] = val;
  }

  const rawScripts = loadZipDir('scripts');
  for (const [key, val] of Object.entries(rawScripts)) {
    if (typeof val === 'string') {
      scripts[key] = {src: val};
    }
  }

  return {
    frontmatter,
    instructions: body,
    resources: {
      references,
      assets,
      scripts,
    },
  };
}
