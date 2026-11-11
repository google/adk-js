/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks that a subject follows the Conventional Commits notation that
 * release-please parses to pick the next version and write the changelog.
 *
 * Pull requests land on main as a squash commit whose subject is the PR title,
 * so the PR title is what release-please actually reads.
 *
 * Usage:
 *   node scripts/check_commit_message.mjs "fix(dev): stop dropping stdin"
 *   node scripts/check_commit_message.mjs --file .git/COMMIT_EDITMSG
 *   git log -1 --pretty=%B | node scripts/check_commit_message.mjs --stdin
 */

import {appendFileSync, readFileSync} from 'node:fs';

// The types release-please understands. Anything outside this list is treated
// as an unparseable subject and silently skipped when the release is cut.
const TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
];

const MINOR_TYPES = ['feat'];
const PATCH_TYPES = ['fix', 'perf'];

const MAX_SUBJECT_LENGTH = 100;
const MIN_DESCRIPTION_LENGTH = 5;

const SUBJECT_PATTERN =
  /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?:(?<spacing> *)(?<description>.*)$/;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

// GitHub's "Revert" button quotes the original subject, and a squash merge
// appends the PR number. Both wrap an otherwise valid subject.
const REVERT_PATTERN = /^Revert "(?<reverted>.+)"$/;
const SQUASH_SUFFIX_PATTERN = / *\(#\d+\)$/;

const EXAMPLES = [
  'fix(dev): stop dropping piped stdin lines',
  'feat(core): implement Runner.runLive',
  'docs: describe what a JoinNode barrier waits for',
  'refactor(workflow)!: collapse LLMAgentWrapper into LlmAgent',
];

/**
 * Validates the first line of a commit message.
 *
 * @param {string} subject
 * @return {{errors: string[], type?: string, breaking: boolean}}
 */
function checkSubject(subject) {
  const errors = [];

  // The "(#123)" suffix and the "Revert \"...\"" wrapper are both machinery
  // GitHub adds, so strip them before measuring and matching. A PR title and
  // the squash commit it becomes then read alike, and a revert is judged on
  // the subject it quotes rather than on the wrapper's extra characters.
  let core = subject.replace(SQUASH_SUFFIX_PATTERN, '');

  const revert = REVERT_PATTERN.exec(core);
  if (revert) {
    core = revert.groups.reverted.replace(SQUASH_SUFFIX_PATTERN, '');
  }

  if (core.length > MAX_SUBJECT_LENGTH) {
    errors.push(
      `Subject is ${core.length} characters. Keep it to ` +
        `${MAX_SUBJECT_LENGTH} or fewer so the changelog stays readable.`,
    );
  }

  const match = SUBJECT_PATTERN.exec(core);
  if (!match) {
    errors.push(
      'Subject does not match "<type>(<optional scope>): <description>".',
    );
    return {errors, breaking: false};
  }

  const {type, scope, breaking, spacing, description} = match.groups;

  if (!TYPES.includes(type)) {
    const lowered = type.toLowerCase();
    if (TYPES.includes(lowered)) {
      errors.push(`Type must be lowercase: write "${lowered}", not "${type}".`);
    } else {
      errors.push(
        `"${type}" is not a known type. Use one of: ${TYPES.join(', ')}.`,
      );
    }
  }

  if (scope !== undefined && !SCOPE_PATTERN.test(scope)) {
    errors.push(
      scope.trim() === ''
        ? 'Scope is empty. Drop the parentheses or name a scope, e.g. "fix(dev):".'
        : `Scope "${scope}" must be lowercase with no spaces, e.g. "fix(dev):".`,
    );
  }

  if (spacing !== ' ') {
    errors.push('Put exactly one space after the colon.');
  }

  if (description.trim() === '') {
    errors.push('Add a description after the colon.');
  } else if (description.trim().length < MIN_DESCRIPTION_LENGTH) {
    errors.push('Description is too short to say what changed.');
  } else if (description.endsWith('.')) {
    errors.push('Drop the trailing period from the description.');
  }

  return {
    errors,
    type: TYPES.includes(type) ? type : undefined,
    breaking: breaking === '!',
  };
}

/**
 * Validates the lines after the subject. A PR title has none.
 *
 * @param {string[]} lines
 * @return {{errors: string[], breaking: boolean}}
 */
function checkBody(lines) {
  const errors = [];

  if (lines.length > 0 && lines[0].trim() !== '') {
    errors.push('Leave a blank line between the subject and the body.');
  }

  // release-please only honours the footer spelled exactly this way.
  const breaking = lines.some((line) =>
    /^BREAKING[ -]CHANGE: .+/.test(line.trim()),
  );
  const malformed = lines.some(
    (line) =>
      /^breaking[ -]change/i.test(line.trim()) &&
      !/^BREAKING[ -]CHANGE: .+/.test(line.trim()),
  );
  if (malformed && !breaking) {
    errors.push(
      'A breaking change footer must read "BREAKING CHANGE: <what broke>", ' +
        'in capitals, or the release will not be a major one.',
    );
  }

  return {errors, breaking};
}

/**
 * Describes the release the message will produce, so the author can catch a
 * wrong type before it ships.
 *
 * @param {string | undefined} type
 * @param {boolean} breaking
 * @return {string}
 */
function describeRelease(type, breaking) {
  if (breaking) {
    return 'a major release (breaking change)';
  }
  if (MINOR_TYPES.includes(type)) {
    return 'a minor release';
  }
  if (PATCH_TYPES.includes(type)) {
    return 'a patch release';
  }
  return 'no release, changelog only';
}

/**
 * @param {string[]} argv
 * @return {{message: string, label: string}}
 */
function readInput(argv) {
  let label = 'Commit message';
  let message;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') {
      label = argv[++i] ?? label;
    } else if (arg === '--file') {
      const path = argv[++i];
      if (!path) {
        throw new Error('--file needs a path.');
      }
      message = readFileSync(path, 'utf8');
    } else if (arg === '--stdin') {
      message = readFileSync(0, 'utf8');
    } else if (message === undefined) {
      message = arg;
    }
  }

  if (message === undefined) {
    throw new Error(
      'Nothing to check. Pass a message, --file <path> or --stdin.',
    );
  }

  return {message, label};
}

/**
 * @param {string} text
 */
function writeStepSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    appendFileSync(path, `${text}\n\n`);
  }
}

function main() {
  let input;
  try {
    input = readInput(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  const {message, label} = input;

  // Comment lines are what git leaves in COMMIT_EDITMSG; they never reach the
  // stored message.
  const lines = message
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()
    .split('\n');

  const subject = lines[0].trim();
  if (subject === '') {
    console.error(`${label} is empty.`);
    process.exitCode = 1;
    return;
  }

  const subjectResult = checkSubject(subject);
  const bodyResult = checkBody(lines.slice(1));
  const errors = [...subjectResult.errors, ...bodyResult.errors];
  const breaking = subjectResult.breaking || bodyResult.breaking;

  if (errors.length === 0) {
    const release = describeRelease(subjectResult.type, breaking);
    console.log(`${label} follows Conventional Commits: ${subject}`);
    console.log(`release-please will treat this as ${release}.`);
    writeStepSummary(`**${label} OK** — release-please reads this as ${release}.

\`\`\`
${subject}
\`\`\``);
    return;
  }

  const report = [
    `${label} does not follow Conventional Commits:`,
    '',
    `    ${subject}`,
    '',
    ...errors.map((error) => `  - ${error}`),
    '',
    'release-please derives the version and the changelog from this line, so',
    'a subject it cannot parse is left out of the release notes entirely.',
    '',
    'Expected: <type>(<optional scope>): <description>',
    `Types:    ${TYPES.join(', ')}`,
    'Breaking: add "!" before the colon, e.g. "feat(core)!: ...".',
    '',
    'Examples:',
    ...EXAMPLES.map((example) => `  ${example}`),
  ].join('\n');

  console.error(report);
  writeStepSummary(`**${label} is not a conventional commit**

\`\`\`
${subject}
\`\`\`

${errors.map((error) => `- ${error}`).join('\n')}

release-please derives the version and the changelog from this line. Edit it to
match \`<type>(<optional scope>): <description>\`, for example:

\`\`\`
${EXAMPLES[0]}
\`\`\``);
  process.exitCode = 1;
}

main();
