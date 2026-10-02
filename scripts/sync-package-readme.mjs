/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates the published README for a workspace package from the repository
 * README.
 *
 * npmjs.com renders the README that ships inside the tarball, and it resolves
 * relative links against nothing at all: a `](LICENSE)` link or a relative
 * `<img src>` is simply broken on the package page. So the repository README is
 * copied into the package with every relative link and image rewritten to an
 * absolute github.com / raw.githubusercontent.com URL.
 *
 * This runs from each package's `prepublishOnly`, so the published page can
 * never drift from the repository README. The generated file is also committed
 * so that it is reviewable and visible on GitHub; `--check` fails when the
 * committed copy is stale.
 *
 * Usage:
 *   node scripts/sync-package-readme.mjs            # regenerate every package
 *   node scripts/sync-package-readme.mjs core       # regenerate one package
 *   node scripts/sync-package-readme.mjs --check    # verify, do not write
 */

import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Branch the absolute URLs point at. */
const BRANCH = 'main';

/** Base URL for links to files in the repository. */
const BLOB_BASE = `https://github.com/google/adk-js/blob/${BRANCH}/`;

/** Base URL for images, which must be served raw rather than as an HTML page. */
const RAW_BASE = `https://raw.githubusercontent.com/google/adk-js/${BRANCH}/`;

/** Packages whose README is generated from the repository README. */
const GENERATED_PACKAGES = ['core'];

const BANNER = `<!--
  This file is generated from the repository README.md by
  scripts/sync-package-readme.mjs. Do not edit it by hand: edit README.md at
  the repository root and run \`npm run readme:sync\`.
-->
`;

/**
 * Reports whether a link target already resolves without a base, and so must be
 * left alone.
 *
 * @param {string} target Link or image target from the source markdown.
 * @return {boolean} True when the target needs no rewriting.
 */
function isAlreadyResolvable(target) {
  // Absolute URLs (https:, mailto:, data:), protocol-relative URLs, and
  // in-document anchors all resolve on npmjs.com as-is.
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target);
}

/**
 * Turns a repository-relative path into an absolute URL.
 *
 * @param {string} target Repository-relative path, e.g. `./CONTRIBUTING.md`.
 * @param {boolean} isImage Whether the target is an image.
 * @return {string} An absolute github.com or raw.githubusercontent.com URL.
 */
function absolutize(target, isImage) {
  if (isAlreadyResolvable(target)) {
    return target;
  }
  const path = target.replace(/^\.\//, '').replace(/^\//, '');
  return (isImage ? RAW_BASE : BLOB_BASE) + path;
}

/**
 * Builds a regex matching a markdown inline link or image. The link-text group
 * tolerates one level of nested brackets so that badge links
 * (`[![alt](img)](href)`) are captured as a single link rather than split
 * apart. A fresh instance is returned per call because the pattern is used
 * re-entrantly.
 *
 * @return {!RegExp} A global regex matching inline links and images.
 */
function inlineLinkPattern() {
  return /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g;
}

/**
 * Rewrites an inline link or image match, recursing into the link text so that
 * a nested image (a badge link) is rewritten too.
 *
 * @param {string} _match The whole match.
 * @param {string} bang `!` when the match is an image.
 * @param {string} text The link text or image alt text.
 * @param {string} target The link or image target.
 * @param {string} title The optional title suffix.
 * @return {string} The rewritten link or image.
 */
function rewriteInlineLink(_match, bang, text, target, title) {
  const bare = target.replace(/^<|>$/g, '');
  const inner = bang
    ? text
    : text.replace(inlineLinkPattern(), rewriteInlineLink);
  return `${bang}[${inner}](${absolutize(bare, bang === '!')}${title})`;
}

/**
 * Rewrites every relative link and image in a markdown document so that it
 * resolves from npmjs.com.
 *
 * @param {string} markdown The repository README.
 * @return {string} The same document with absolute links and images.
 */
export function absolutizeLinks(markdown) {
  return (
    markdown
      // Inline links and images: [text](target) and ![alt](target "title").
      .replace(inlineLinkPattern(), rewriteInlineLink)
      // Reference definitions: [label]: target "title"
      .replace(
        /^(\s*\[[^\]]+\]:\s*)(\S+)/gm,
        (_match, prefix, target) => `${prefix}${absolutize(target, false)}`,
      )
      // Raw HTML attributes: <img src="...">, <a href="...">.
      .replace(
        /\b(src|href)=(["'])([^"']+)\2/g,
        (_match, attr, quote, target) =>
          `${attr}=${quote}${absolutize(target, attr === 'src')}${quote}`,
      )
  );
}

/**
 * Renders the README that should ship inside a package tarball.
 *
 * @param {string} rootReadme Contents of the repository README.
 * @return {string} The package README contents.
 */
export function renderPackageReadme(rootReadme) {
  return `${BANNER}\n${absolutizeLinks(rootReadme)}`;
}

/**
 * Regenerates (or verifies) the README of each requested package.
 *
 * @param {{packages: !Array<string>, check: boolean}} options Run options.
 * @return {!Promise<number>} Process exit code.
 */
async function run({packages, check}) {
  const rootReadme = await readFile(join(REPO_ROOT, 'README.md'), 'utf8');
  const expected = renderPackageReadme(rootReadme);
  const stale = [];

  for (const pkg of packages) {
    const target = join(REPO_ROOT, pkg, 'README.md');
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current === expected) {
      continue;
    }
    if (check) {
      stale.push(`${pkg}/README.md`);
      continue;
    }
    await writeFile(target, expected);
    console.log(`Wrote ${pkg}/README.md from README.md`);
  }

  if (stale.length > 0) {
    console.error(
      `The following generated READMEs are out of date:\n` +
        stale.map((f) => `  - ${f}`).join('\n') +
        `\n\nRun \`npm run readme:sync\` and commit the result.`,
    );
    return 1;
  }
  return 0;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const requested = args.filter((arg) => !arg.startsWith('--'));
const unknown = requested.filter((pkg) => !GENERATED_PACKAGES.includes(pkg));
if (unknown.length > 0) {
  console.error(
    `Unknown package(s): ${unknown.join(', ')}. ` +
      `Known: ${GENERATED_PACKAGES.join(', ')}.`,
  );
  process.exit(1);
}

process.exit(
  await run({
    packages: requested.length > 0 ? requested : GENERATED_PACKAGES,
    check,
  }),
);
