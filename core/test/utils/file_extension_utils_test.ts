/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  CodeExecutionLanguage,
  FileContentEncoding,
} from '../../src/code_executors/code_execution_utils.js';
import {
  getMimeTypeAndEncoding,
  getScriptLanguageByExtension,
} from '../../src/utils/file_extension_utils.js';

describe('getMimeTypeAndEncoding', () => {
  describe('text extensions (UTF-8)', () => {
    it.each([
      ['.js', 'text/javascript'],
      ['.py', 'text/x-python'],
      ['.md', 'text/markdown'],
      ['.txt', 'text/plain'],
      ['.html', 'text/html'],
      ['.css', 'text/css'],
      ['.json', 'application/json'],
      ['.csv', 'text/csv'],
      ['.svg', 'image/svg+xml'],
      ['.xml', 'application/xml'],
      ['.yaml', 'text/yaml'],
      ['.yml', 'text/yaml'],
    ])('returns correct MIME type for %s', (ext, expectedMime) => {
      const result = getMimeTypeAndEncoding(ext);
      expect(result.mimeType).toBe(expectedMime);
      expect(result.encoding).toBe(FileContentEncoding.UTF8);
    });
  });

  describe('binary extensions (BASE64)', () => {
    it.each([
      ['.png', 'image/png'],
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.pdf', 'application/pdf'],
    ])('returns correct MIME type for %s', (ext, expectedMime) => {
      const result = getMimeTypeAndEncoding(ext);
      expect(result.mimeType).toBe(expectedMime);
      expect(result.encoding).toBe(FileContentEncoding.BASE64);
    });
  });

  describe('unknown extension', () => {
    it('returns application/octet-stream with BASE64 for unknown extension', () => {
      const result = getMimeTypeAndEncoding('.unknown');
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.encoding).toBe(FileContentEncoding.BASE64);
    });

    it('returns fallback for empty string extension', () => {
      const result = getMimeTypeAndEncoding('');
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.encoding).toBe(FileContentEncoding.BASE64);
    });
  });

  describe('case-insensitivity', () => {
    it('treats .JS the same as .js', () => {
      expect(getMimeTypeAndEncoding('.JS')).toEqual(
        getMimeTypeAndEncoding('.js'),
      );
    });

    it('treats .PNG the same as .png', () => {
      expect(getMimeTypeAndEncoding('.PNG')).toEqual(
        getMimeTypeAndEncoding('.png'),
      );
    });

    it('treats .JSON the same as .json', () => {
      expect(getMimeTypeAndEncoding('.JSON')).toEqual(
        getMimeTypeAndEncoding('.json'),
      );
    });
  });
});

describe('getScriptLanguageByExtension', () => {
  describe('known language extensions', () => {
    it.each([
      ['.js', CodeExecutionLanguage.JAVASCRIPT],
      ['.ts', CodeExecutionLanguage.TYPESCRIPT],
      ['.py', CodeExecutionLanguage.PYTHON],
      ['.bat', CodeExecutionLanguage.WINDOWS_CMD],
      ['.cmd', CodeExecutionLanguage.WINDOWS_CMD],
      ['.ps1', CodeExecutionLanguage.POWERSHELL],
      ['.sh', CodeExecutionLanguage.SHELL],
    ])('returns correct language for %s', (ext, expectedLang) => {
      expect(getScriptLanguageByExtension(ext)).toBe(expectedLang);
    });
  });

  describe('unknown extension', () => {
    it('returns UNSPECIFIED for unknown extension', () => {
      expect(getScriptLanguageByExtension('.rb')).toBe(
        CodeExecutionLanguage.UNSPECIFIED,
      );
    });

    it('returns UNSPECIFIED for empty string', () => {
      expect(getScriptLanguageByExtension('')).toBe(
        CodeExecutionLanguage.UNSPECIFIED,
      );
    });
  });

  describe('case-insensitivity', () => {
    it('treats .PY the same as .py', () => {
      expect(getScriptLanguageByExtension('.PY')).toBe(
        getScriptLanguageByExtension('.py'),
      );
    });

    it('treats .SH the same as .sh', () => {
      expect(getScriptLanguageByExtension('.SH')).toBe(
        getScriptLanguageByExtension('.sh'),
      );
    });
  });
});
