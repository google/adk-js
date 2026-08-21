/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isCancel, select, text} from '@clack/prompts';
import {execSync} from 'node:child_process';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  vi,
} from 'vitest';
import {createAgent} from '../../src/cli/cli_create.js';
import {
  createFolder,
  isFolderExists,
  listFiles,
  removeFolder,
  saveToFile,
} from '../../src/utils/file_utils.js';

vi.mock('@clack/prompts', () => ({
  isCancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn((cmd, opts, callback) => {
    if (callback) callback(null, 'stdout', 'stderr');
    return {
      on: (event: string, cb: () => void) => {
        if (event === 'exit') cb();
      },
    };
  }),
  execSync: vi.fn(),
}));

// Only the I/O is faked; getAbsolutePath is the real resolver under test.
vi.mock('../../src/utils/file_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file_utils.js')>()),
  createFolder: vi.fn(),
  isFolderExists: vi.fn(),
  listFiles: vi.fn(),
  removeFolder: vi.fn(),
  saveToFile: vi.fn(),
}));

describe('createAgent', () => {
  const getFreshOptions = () => ({
    agentName: 'test-agent',
    forceYes: false,
    model: '',
    apiKey: '',
    project: '',
    region: '',
    language: '',
  });

  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // getGcpProject()/getGcpRegion() read these before falling back to
    // `gcloud config get-value`, so on a developer machine that exports them
    // the mocked execSync is never consulted and the assertions below see the
    // real local project/region instead of the mocked gcloud output. Clear
    // them so the gcloud fallback is what actually gets exercised.
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
    (isCancel as unknown as Mock).mockReturnValue(false);
    (listFiles as Mock).mockResolvedValue(['file1', 'file2']);
    // `createAgent` prefers these over `gcloud config`, so a machine with
    // either one exported takes a different path through the code than the one
    // under test. Clear them: what this suite asserts has to come from its own
    // mocks, not from the environment that happens to be running it.
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('Non-interactive Mode (forceYes: true)', () => {
    it('should create agent with default values when minimal args provided', async () => {
      await createAgent({...getFreshOptions(), forceYes: true});

      expect(isFolderExists).toHaveBeenCalled();
      expect(createFolder).toHaveBeenCalled();

      // Verify defaults
      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('agent.ts'),
        expect.stringContaining("model: 'gemini-2.5-flash'"),
      );
      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('package.json'),
        expect.stringContaining('"main": "agent.ts"'),
      );
    });

    it('should use provided model and language', async () => {
      await createAgent({
        ...getFreshOptions(),
        forceYes: true,
        model: 'gemini-pro',
        language: 'js',
      });

      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('agent.js'),
        expect.stringContaining("model: 'gemini-pro'"),
      );
      expect(saveToFile).not.toHaveBeenCalledWith(
        expect.stringContaining('tsconfig.json'),
        expect.anything(),
      );
    });

    it('should set Vertex AI env vars if project/region provided', async () => {
      await createAgent({
        ...getFreshOptions(),
        forceYes: true,
        project: 'my-project',
        region: 'us-central1',
      });

      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('GOOGLE_CLOUD_PROJECT=my-project'),
      );
      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('GOOGLE_GENAI_USE_VERTEXAI=1'),
      );
    });

    it('should set Google AI env vars if api key provided', async () => {
      await createAgent({
        ...getFreshOptions(),
        forceYes: true,
        apiKey: 'my-api-key',
      });

      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('GOOGLE_GENAI_API_KEY=my-api-key'),
      );
    });
  });

  describe('Interactive Mode', () => {
    it('should prompt for model if not provided', async () => {
      (select as Mock).mockResolvedValueOnce('gemini-2.5-pro'); // Model
      (select as Mock).mockResolvedValueOnce('ts'); // Language
      (select as Mock).mockResolvedValueOnce('googleai'); // Backend
      (text as Mock).mockResolvedValueOnce('test-key'); // API Key

      await createAgent(getFreshOptions());

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Choose a model for the root agent',
        }),
      );
      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('agent.ts'),
        expect.stringContaining("model: 'gemini-2.5-pro'"),
      );
    });

    it('should exit if model selection is cancelled', async () => {
      (select as Mock).mockResolvedValueOnce('cancel-symbol');
      (isCancel as unknown as Mock).mockReturnValue(true);

      await expect(createAgent(getFreshOptions())).rejects.toThrow(
        /process\.exit/,
      );
    });

    it('should prompt for language if not provided', async () => {
      (select as Mock).mockResolvedValueOnce('gemini-2.5-flash');
      (select as Mock).mockResolvedValueOnce('js');
      (select as Mock).mockResolvedValueOnce('googleai');
      (text as Mock).mockResolvedValueOnce('test-key');

      await createAgent(getFreshOptions());

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Choose a language for the agent',
          options: expect.arrayContaining([{label: 'JavaScript', value: 'js'}]),
        }),
      );
      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('agent.js'),
        expect.anything(),
      );
    });

    it('should handle Vertex AI selection with gcloud defaults', async () => {
      (select as Mock).mockResolvedValueOnce('gemini-2.5-flash');
      (select as Mock).mockResolvedValueOnce('ts');
      (select as Mock).mockResolvedValueOnce('vertex'); // Backend

      (execSync as Mock).mockImplementation((cmd: string) => {
        if (cmd.includes('project')) return 'gcloud-project\n';
        if (cmd.includes('region')) return 'gcloud-region\n';
        return '';
      });

      (text as Mock).mockResolvedValueOnce('gcloud-project');
      (text as Mock).mockResolvedValueOnce('gcloud-region');

      await createAgent(getFreshOptions());

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: 'gcloud-project',
        }),
      );
      expect(saveToFile).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('GOOGLE_CLOUD_PROJECT=gcloud-project'),
      );
    });

    it('should prefer the environment over gcloud defaults', async () => {
      // The precedence the test above depends on NOT being in play. It is real
      // behaviour, so pin it here rather than leave it to whatever the machine
      // running the suite happens to export.
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-region');

      (select as Mock).mockResolvedValueOnce('gemini-2.5-flash');
      (select as Mock).mockResolvedValueOnce('ts');
      (select as Mock).mockResolvedValueOnce('vertex'); // Backend

      (execSync as Mock).mockImplementation((cmd: string) => {
        if (cmd.includes('project')) return 'gcloud-project\n';
        if (cmd.includes('region')) return 'gcloud-region\n';
        return '';
      });

      (text as Mock).mockResolvedValueOnce('env-project');
      (text as Mock).mockResolvedValueOnce('env-region');

      await createAgent(getFreshOptions());

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({initialValue: 'env-project'}),
      );
      // `gcloud config` is not consulted at all when the env supplies both.
      expect(execSync).not.toHaveBeenCalled();
    });

    it('should exit without writing files if project prompt is cancelled', async () => {
      // Mirror clack's contract: only the raw cancel symbol counts as a cancel.
      (isCancel as unknown as Mock).mockImplementation(
        (value: unknown) => typeof value === 'symbol',
      );
      (select as Mock).mockResolvedValueOnce('gemini-2.5-flash'); // Model
      (select as Mock).mockResolvedValueOnce('ts'); // Language
      (select as Mock).mockResolvedValueOnce('vertex'); // Backend
      (text as Mock).mockResolvedValueOnce(Symbol('clack:cancel')); // Project

      await expect(createAgent(getFreshOptions())).rejects.toThrow(
        /process\.exit/,
      );

      expect(saveToFile).not.toHaveBeenCalled();
    });
  });

  describe('Folder Handling', () => {
    it('should ask to overwrite if folder exists', async () => {
      (isFolderExists as Mock).mockResolvedValue(true);
      (select as Mock).mockResolvedValueOnce(true); // Overwrite = Yes

      // Follow up choices since we continue
      (select as Mock).mockResolvedValue('gemini-2.5-flash');
      (select as Mock).mockResolvedValue('ts');
      (select as Mock).mockResolvedValue('googleai');
      (text as Mock).mockResolvedValue('key');

      await createAgent(getFreshOptions());

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('already exists'),
        }),
      );
      expect(removeFolder).toHaveBeenCalled();
    });

    it('should exit if user declines overwrite', async () => {
      (isFolderExists as Mock).mockResolvedValue(true);
      (select as Mock).mockResolvedValueOnce(false); // Overwrite = No

      await expect(createAgent(getFreshOptions())).rejects.toThrow(
        /process\.exit/,
      );
      expect(removeFolder).not.toHaveBeenCalled();
    });
  });
});
