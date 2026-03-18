/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill} from './models.js';

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats available skills into a standard XML string.
 *
 * @param skills A list of skill frontmatter or full skill objects.
 * @returns XML string with <available_skills> block.
 */
export function formatSkillsAsXml(skills: Array<Skill | Frontmatter>): string {
  if (!skills || skills.length === 0) {
    return '<available_skills>\n</available_skills>';
  }

  const lines = ['<available_skills>'];

  for (const item of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeHtml(item.name)}</name>`);
    lines.push(
      `    <description>${escapeHtml(item.description)}</description>`,
    );
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');

  return lines.join('\n');
}
