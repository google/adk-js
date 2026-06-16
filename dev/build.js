/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {createWriteStream, existsSync, unlink} from 'node:fs';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import * as https from 'node:https';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import AdmZip from 'adm-zip';
import {shimPlugin} from 'esbuild-shim-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADK_WEB_VERSION = 'v1.0.0';
const cacheDir = path.join(__dirname, '.cache');
const zipCachePath = path.join(cacheDir, `adk-web-${ADK_WEB_VERSION}.zip`);

const licenseHeaderText = `/**
  * @license
  * Copyright 2026 Google LLC
  * SPDX-License-Identifier: Apache-2.0
  */
`;

const commonOptions = {
  target: 'node16',
  platform: 'node',
  packages: 'external',
  logLevel: 'info',
  banner: {js: licenseHeaderText},
  plugins: [shimPlugin()],
  sourcemap: false,
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        // Follow redirect
        response.resume();
        downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(
          new Error(
            `Failed to get '${url}' (status code: ${response.statusCode})`,
          ),
        );
        return;
      }

      const file = createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(undefined);
      });
      file.on('error', (err) => {
        unlink(dest, () => reject(err));
      });
    });

    request.on('error', (err) => {
      unlink(dest, () => reject(err));
    });
  });
}

function unzipFile(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
}

async function ensureBrowserAssets() {
  const browserOutputDir = path.join(__dirname, 'dist/browser');
  const versionFile = path.join(browserOutputDir, '.version');

  let needPopulate = false;

  if (!existsSync(browserOutputDir)) {
    needPopulate = true;
  } else {
    try {
      const version = (await readFile(versionFile, 'utf8')).trim();
      if (version !== ADK_WEB_VERSION) needPopulate = true;
    } catch {
      needPopulate = true;
    }
  }

  if (needPopulate) {
    if (!existsSync(zipCachePath)) {
      console.log(
        `[ADK Build] ADK Web zip not cached. Fetching ${ADK_WEB_VERSION} from GitHub...`,
      );
      if (!existsSync(cacheDir)) {
        await mkdir(cacheDir, {recursive: true});
      }
      const url = `https://github.com/google/adk-web/releases/download/${ADK_WEB_VERSION}/adk-web-browser.zip`;
      const tempZipPath = `${zipCachePath}.tmp`;
      await downloadFile(url, tempZipPath);
      await rename(tempZipPath, zipCachePath);
      console.log(
        `[ADK Build] Downloaded and cached ADK Web ${ADK_WEB_VERSION}.`,
      );
    }

    console.log(`[ADK Build] Extracting ADK Web assets to dist/browser...`);
    if (existsSync(browserOutputDir)) {
      await rm(browserOutputDir, {recursive: true, force: true});
    }
    await mkdir(browserOutputDir, {recursive: true});
    unzipFile(zipCachePath, browserOutputDir);
    await writeFile(versionFile, ADK_WEB_VERSION, 'utf8');
    console.log(`[ADK Build] ADK Web assets successfully populated.`);
  }
}

/**
 * Builds the ADK devtools library.
 */
async function main() {
  // Run builds in parallel
  await Promise.all([
    esbuild.build({
      ...commonOptions,
      entryPoints: ['./src/**/*.ts'],
      outdir: 'dist/esm',
      format: 'esm',
      bundle: false,
      minify: false,
    }),
    esbuild.build({
      ...commonOptions,
      entryPoints: ['./src/**/*.ts'],
      outdir: 'dist/cjs',
      format: 'cjs',
      bundle: false,
      minify: false,
    }),
  ]);

  // Run file operations sequentially to avoid race conditions
  await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  await ensureBrowserAssets();
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
