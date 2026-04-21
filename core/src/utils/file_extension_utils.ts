/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  FileContentEncoding,
} from '../code_executors/code_execution_utils.js';

const MIME_TYPE_MAP: Record<
  string,
  {mimeType: string; encoding: FileContentEncoding}
> = {
  '.js': {mimeType: 'text/javascript', encoding: FileContentEncoding.UTF8},
  '.py': {mimeType: 'text/x-python', encoding: FileContentEncoding.UTF8},
  '.md': {mimeType: 'text/markdown', encoding: FileContentEncoding.UTF8},
  '.txt': {mimeType: 'text/plain', encoding: FileContentEncoding.UTF8},
  '.html': {mimeType: 'text/html', encoding: FileContentEncoding.UTF8},
  '.css': {mimeType: 'text/css', encoding: FileContentEncoding.UTF8},
  '.json': {mimeType: 'application/json', encoding: FileContentEncoding.UTF8},
  '.csv': {mimeType: 'text/csv', encoding: FileContentEncoding.UTF8},
  '.svg': {mimeType: 'image/svg+xml', encoding: FileContentEncoding.UTF8},
  '.xml': {mimeType: 'application/xml', encoding: FileContentEncoding.UTF8},
  '.yaml': {mimeType: 'text/yaml', encoding: FileContentEncoding.UTF8},
  '.yml': {mimeType: 'text/yaml', encoding: FileContentEncoding.UTF8},
  '.png': {mimeType: 'image/png', encoding: FileContentEncoding.BASE64},
  '.jpg': {mimeType: 'image/jpeg', encoding: FileContentEncoding.BASE64},
  '.jpeg': {mimeType: 'image/jpeg', encoding: FileContentEncoding.BASE64},
  '.pdf': {mimeType: 'application/pdf', encoding: FileContentEncoding.BASE64},
};

const EXTENSION_TO_LANGUAGE: Record<string, CodeExecutionLanguage> = {
  '.js': CodeExecutionLanguage.JAVASCRIPT,
  '.ts': CodeExecutionLanguage.TYPESCRIPT,
  '.py': CodeExecutionLanguage.PYTHON,
  '.bat': CodeExecutionLanguage.WINDOWS_CMD,
  '.cmd': CodeExecutionLanguage.WINDOWS_CMD,
  '.ps1': CodeExecutionLanguage.POWERSHELL,
  '.sh': CodeExecutionLanguage.SHELL,
};

/**
 * Gets the MIME type and file content encoding for a given file extension.
 * @param ext The file extension (e.g., '.js', '.png').
 * @returns An object containing the mimeType and encoding.
 */
export function getMimeTypeAndEncoding(ext: string): {
  mimeType: string;
  encoding: FileContentEncoding;
} {
  return (
    MIME_TYPE_MAP[ext.toLowerCase()] || {
      mimeType: 'application/octet-stream',
      encoding: FileContentEncoding.BASE64,
    }
  );
}

/**
 * Gets the code execution language for a given file extension.
 * @param ext The file extension (e.g., '.js', '.py').
 * @returns The code execution language.
 */
export function getScriptLanguageByExtension(
  ext: string,
): CodeExecutionLanguage {
  return (
    EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ||
    CodeExecutionLanguage.UNSPECIFIED
  );
}
