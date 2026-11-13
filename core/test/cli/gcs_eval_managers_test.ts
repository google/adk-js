/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createGcsEvalManagersFromUri,
  EvalCase,
  EvalResult,
  EvalStatus,
  GcsEvalSetResultsManager,
  GcsEvalSetsManager,
  InputValidationError,
  NotFoundError,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {StorageMock, fakeStorage} = vi.hoisted(() => {
  interface StoredBlob {
    data: string;
    contentType?: string;
  }

  class FakeFile {
    constructor(
      readonly name: string,
      private readonly bucket: FakeBucket,
    ) {}

    async exists(): Promise<[boolean]> {
      return [this.bucket.blobs.has(this.name)];
    }

    async download(): Promise<[Buffer]> {
      const blob = this.bucket.blobs.get(this.name);
      if (!blob) {
        throw Object.assign(new Error(`No such object: ${this.name}`), {
          code: 404,
        });
      }
      return [Buffer.from(blob.data, 'utf-8')];
    }

    async save(data: string, options?: {contentType?: string}): Promise<void> {
      this.bucket.blobs.set(this.name, {
        data,
        contentType: options?.contentType,
      });
    }
  }

  class FakeBucket {
    readonly blobs = new Map<string, StoredBlob>();
    listError?: unknown;

    constructor(
      readonly name: string,
      private readonly storage: FakeStorage,
    ) {}

    file(name: string): FakeFile {
      this.storage.calls.push(`file:${name}`);
      return new FakeFile(name, this);
    }

    async exists(): Promise<[boolean]> {
      this.storage.calls.push(`bucket.exists:${this.name}`);
      return [this.storage.existingBuckets.has(this.name)];
    }

    async getFiles(options?: {prefix?: string}): Promise<[FakeFile[]]> {
      if (this.listError !== undefined) {
        throw this.listError;
      }
      const prefix = options?.prefix ?? '';
      return [
        [...this.blobs.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => new FakeFile(name, this)),
      ];
    }
  }

  class FakeStorage {
    readonly buckets = new Map<string, FakeBucket>();
    readonly existingBuckets = new Set<string>();
    readonly calls: string[] = [];

    bucket(name: string): FakeBucket {
      let bucket = this.buckets.get(name);
      if (!bucket) {
        bucket = new FakeBucket(name, this);
        this.buckets.set(name, bucket);
      }
      return bucket;
    }

    reset(): void {
      this.buckets.clear();
      this.existingBuckets.clear();
      this.calls.length = 0;
    }
  }

  const fakeStorage = new FakeStorage();
  const StorageMock = vi.fn(function () {
    return fakeStorage;
  });
  return {StorageMock, fakeStorage};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

const BUCKET = 'test-bucket';
const APP = 'test_app';
const EVAL_SET_ID = 'test_eval_set';
const EVAL_SET_BLOB = `${APP}/evals/eval_sets/${EVAL_SET_ID}.evalset.json`;

function blobs(): Map<string, {data: string; contentType?: string}> {
  return fakeStorage.bucket(BUCKET).blobs;
}

function putJson(name: string, value: unknown): void {
  blobs().set(name, {data: JSON.stringify(value)});
}

function readJson(name: string): unknown {
  const blob = blobs().get(name);
  if (!blob) {
    throw new Error(`Missing blob ${name}`);
  }
  return JSON.parse(blob.data);
}

function createEvalCase(evalId: string): EvalCase {
  return {evalId, conversation: [], creationTimestamp: 1};
}

function createEvalResult(evalId: string): EvalResult {
  return {
    eval_set_id: EVAL_SET_ID,
    eval_id: evalId,
    final_eval_status: EvalStatus.PASSED,
    overall_eval_metric_results: [],
    eval_metric_result_per_invocation: [],
    session_id: 'session-1',
  };
}

function putEvalSet(...evalIds: string[]): void {
  putJson(EVAL_SET_BLOB, {
    evalSetId: EVAL_SET_ID,
    name: EVAL_SET_ID,
    evalCases: evalIds.map(createEvalCase),
    creationTimestamp: 1,
  });
}

function storedEvalIds(): string[] {
  const stored = readJson(EVAL_SET_BLOB) as {evalCases: EvalCase[]};
  return stored.evalCases.map((c) => c.evalId);
}

beforeEach(() => {
  fakeStorage.reset();
  StorageMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GcsEvalSetsManager', () => {
  let manager: GcsEvalSetsManager;

  beforeEach(() => {
    fakeStorage.existingBuckets.add(BUCKET);
    manager = new GcsEvalSetsManager(BUCKET, {projectId: 'test-project'});
  });

  it('throws InputValidationError when the bucket does not exist', async () => {
    const missingManager = new GcsEvalSetsManager('missing-bucket', {
      projectId: 'test-project',
    });

    await expect(missingManager.getEvalSet(APP, EVAL_SET_ID)).rejects.toThrow(
      new InputValidationError(
        'Bucket `missing-bucket` does not exist. Create it before you use it for eval storage.',
      ),
    );
  });

  it('returns the parsed eval set from its blob', async () => {
    putEvalSet('case_1');

    const evalSet = await manager.getEvalSet(APP, EVAL_SET_ID);

    expect(evalSet?.evalSetId).toBe(EVAL_SET_ID);
    expect(evalSet?.evalCases.map((c) => c.evalId)).toEqual(['case_1']);
    expect(StorageMock).toHaveBeenCalledWith({projectId: 'test-project'});
  });

  it('returns undefined when the eval set blob does not exist', async () => {
    await expect(manager.getEvalSet(APP, EVAL_SET_ID)).resolves.toBeUndefined();
  });

  it('writes an empty eval set as JSON when it creates one', async () => {
    const created = await manager.createEvalSet(APP, EVAL_SET_ID);

    expect(created).toMatchObject({
      evalSetId: EVAL_SET_ID,
      name: EVAL_SET_ID,
      evalCases: [],
    });
    expect(readJson(EVAL_SET_BLOB)).toEqual(created);
    expect(blobs().get(EVAL_SET_BLOB)?.contentType).toBe('application/json');
  });

  it('rejects an eval set ID that does not match the ID format', async () => {
    await expect(
      manager.createEvalSet(APP, 'invalid-id'),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(blobs().size).toBe(0);
  });

  it('rejects creating an eval set that already exists', async () => {
    putEvalSet('kept_case');

    await expect(manager.createEvalSet(APP, EVAL_SET_ID)).rejects.toThrow(
      new InputValidationError(
        `EvalSet ${EVAL_SET_ID} already exists for app ${APP}.`,
      ),
    );
    expect(storedEvalIds()).toEqual(['kept_case']);
  });

  it('lists the sorted eval set IDs of the app and skips other blobs', async () => {
    putJson(`${APP}/evals/eval_sets/b_set.evalset.json`, {});
    putJson(`${APP}/evals/eval_sets/a_set.evalset.json`, {});
    putJson(`${APP}/evals/eval_sets/notes.txt`, {});
    putJson(`${APP}/evals/eval_sets/nested/c_set.evalset.json`, {});
    putJson(`${APP}/evals/eval_sets_old/d_set.evalset.json`, {});
    putJson(`other_app/evals/eval_sets/e_set.evalset.json`, {});

    await expect(manager.listEvalSets(APP)).resolves.toEqual([
      'a_set',
      'b_set',
    ]);
  });

  it('throws NotFoundError when listing answers with a 404', async () => {
    fakeStorage.bucket(BUCKET).listError = Object.assign(
      new Error('Not Found'),
      {code: 404},
    );

    await expect(manager.listEvalSets(APP)).rejects.toThrow(
      new NotFoundError(
        `App \`${APP}\` not found in GCS bucket \`${BUCKET}\`.`,
      ),
    );
  });

  it('passes through a listing error that is not a 404', async () => {
    const error = Object.assign(new Error('Forbidden'), {code: 403});
    fakeStorage.bucket(BUCKET).listError = error;

    await expect(manager.listEvalSets(APP)).rejects.toBe(error);
  });

  it('adds an eval case to an existing eval set', async () => {
    putEvalSet('case_1');

    await manager.addEvalCase(APP, EVAL_SET_ID, createEvalCase('case_2'));

    expect(storedEvalIds()).toEqual(['case_1', 'case_2']);
  });

  it('throws NotFoundError when adding a case to a missing eval set', async () => {
    await expect(
      manager.addEvalCase(APP, EVAL_SET_ID, createEvalCase('case_1')),
    ).rejects.toThrow(
      new NotFoundError(`Eval set \`${EVAL_SET_ID}\` not found.`),
    );
  });

  it('rejects adding an eval case whose ID already exists', async () => {
    putEvalSet('case_1');

    await expect(
      manager.addEvalCase(APP, EVAL_SET_ID, createEvalCase('case_1')),
    ).rejects.toThrow(
      new InputValidationError(
        `Eval id \`case_1\` already exists in \`${EVAL_SET_ID}\` eval set.`,
      ),
    );
    expect(storedEvalIds()).toEqual(['case_1']);
  });

  it('returns the eval case with the requested ID', async () => {
    putEvalSet('case_1', 'case_2');

    const evalCase = await manager.getEvalCase(APP, EVAL_SET_ID, 'case_2');

    expect(evalCase?.evalId).toBe('case_2');
  });

  it('returns undefined for an eval case of a missing eval set', async () => {
    await expect(
      manager.getEvalCase(APP, EVAL_SET_ID, 'case_1'),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a missing eval case', async () => {
    putEvalSet('case_1');

    await expect(
      manager.getEvalCase(APP, EVAL_SET_ID, 'case_2'),
    ).resolves.toBeUndefined();
  });

  it('replaces an existing eval case', async () => {
    putEvalSet('case_1', 'case_2');

    await manager.updateEvalCase(APP, EVAL_SET_ID, {
      ...createEvalCase('case_1'),
      creationTimestamp: 2,
    });

    const stored = readJson(EVAL_SET_BLOB) as {evalCases: EvalCase[]};
    expect(
      stored.evalCases.map((c) => [c.evalId, c.creationTimestamp]),
    ).toEqual([
      ['case_1', 2],
      ['case_2', 1],
    ]);
  });

  it('throws NotFoundError when updating a case of a missing eval set', async () => {
    await expect(
      manager.updateEvalCase(APP, EVAL_SET_ID, createEvalCase('case_1')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when updating a missing eval case', async () => {
    putEvalSet('case_1');

    await expect(
      manager.updateEvalCase(APP, EVAL_SET_ID, createEvalCase('case_2')),
    ).rejects.toThrow(
      new NotFoundError(
        `Eval Set \`${EVAL_SET_ID}\` or Eval id \`case_2\` not found.`,
      ),
    );
    expect(storedEvalIds()).toEqual(['case_1']);
  });

  it('deletes an existing eval case', async () => {
    putEvalSet('case_1', 'case_2');

    await manager.deleteEvalCase(APP, EVAL_SET_ID, 'case_1');

    expect(storedEvalIds()).toEqual(['case_2']);
  });

  it('throws NotFoundError when deleting a case of a missing eval set', async () => {
    await expect(
      manager.deleteEvalCase(APP, EVAL_SET_ID, 'case_1'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when deleting a missing eval case', async () => {
    putEvalSet('case_1');

    await expect(
      manager.deleteEvalCase(APP, EVAL_SET_ID, 'case_2'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(storedEvalIds()).toEqual(['case_1']);
  });

  it.each([
    ['an app name with a separator', () => manager.createEvalSet('a/b', 'x')],
    ['a traversal app name', () => manager.listEvalSets('..')],
    ['an eval set ID with a separator', () => manager.getEvalSet(APP, 'a/b')],
    ['a traversal eval set ID', () => manager.getEvalSet(APP, '..')],
  ])(
    'rejects %s before it calls storage',
    async (_name, call: () => Promise<unknown>) => {
      await expect(call()).rejects.toBeInstanceOf(InputValidationError);
      expect(fakeStorage.calls).toEqual([]);
    },
  );
});

describe('GcsEvalSetResultsManager', () => {
  let manager: GcsEvalSetResultsManager;

  beforeEach(() => {
    fakeStorage.existingBuckets.add(BUCKET);
    manager = new GcsEvalSetResultsManager(BUCKET, {projectId: 'test-project'});
  });

  it('throws InputValidationError when the bucket does not exist', async () => {
    const missingManager = new GcsEvalSetResultsManager('missing-bucket', {
      projectId: 'test-project',
    });

    await expect(
      missingManager.getEvalSetResult(APP, 'missing-result'),
    ).rejects.toThrow(
      new InputValidationError(
        'Bucket `missing-bucket` does not exist. Create it before you use it for eval storage.',
      ),
    );
  });

  it('saves the result under the eval history directory of the app', async () => {
    const saved = await manager.saveEvalSetResult({
      appName: APP,
      evalSetId: EVAL_SET_ID,
      evalCaseResults: [createEvalResult('case_1')],
    });

    const blobName = `${APP}/evals/eval_history/${saved.evalSetResultName}.evalset_result.json`;
    expect(saved.evalSetResultId.startsWith(`${APP}_${EVAL_SET_ID}_`)).toBe(
      true,
    );
    expect(readJson(blobName)).toEqual(saved);
    expect(blobs().get(blobName)?.contentType).toBe('application/json');
    expect(saved.evalCaseResults[0]).toMatchObject({
      evalSetId: EVAL_SET_ID,
      evalId: 'case_1',
      finalEvalStatus: EvalStatus.PASSED,
    });
  });

  it('throws NotFoundError for a missing result', async () => {
    await expect(manager.getEvalSetResult(APP, 'missing')).rejects.toThrow(
      new NotFoundError('Eval set result `missing` not found.'),
    );
  });

  it('returns a saved result', async () => {
    const saved = await manager.saveEvalSetResult({
      appName: APP,
      evalSetId: EVAL_SET_ID,
      evalCaseResults: [createEvalResult('case_1')],
    });

    await expect(
      manager.getEvalSetResult(APP, saved.evalSetResultId),
    ).resolves.toEqual(saved);
  });

  it('reads a legacy result that was stored as a JSON string', async () => {
    blobs().set(`${APP}/evals/eval_history/legacy.evalset_result.json`, {
      data: JSON.stringify(
        JSON.stringify({
          eval_set_result_id: 'legacy',
          eval_set_id: EVAL_SET_ID,
          eval_case_results: [],
          creation_timestamp: 1,
        }),
      ),
    });

    await expect(manager.getEvalSetResult(APP, 'legacy')).resolves.toEqual({
      evalSetResultId: 'legacy',
      evalSetResultName: 'legacy',
      evalSetId: EVAL_SET_ID,
      evalCaseResults: [],
      creationTimestamp: 1,
    });
  });

  it('lists the sorted result IDs of the app', async () => {
    putJson(`${APP}/evals/eval_history/result_b.evalset_result.json`, {});
    putJson(`${APP}/evals/eval_history/result_a.evalset_result.json`, {});
    putJson(`other_app/evals/eval_history/result_c.evalset_result.json`, {});

    await expect(manager.listEvalSetResults(APP)).resolves.toEqual([
      'result_a',
      'result_b',
    ]);
  });

  it('returns an empty list when the app has no results', async () => {
    await expect(manager.listEvalSetResults(APP)).resolves.toEqual([]);
  });

  it.each([
    [
      'an app name with a separator',
      () =>
        manager.saveEvalSetResult({
          appName: 'a/b',
          evalSetId: EVAL_SET_ID,
          evalCaseResults: [],
        }),
    ],
    [
      'a traversal eval set ID',
      () =>
        manager.saveEvalSetResult({
          appName: APP,
          evalSetId: '..',
          evalCaseResults: [],
        }),
    ],
    ['a traversal app name', () => manager.getEvalSetResult('..', 'id')],
    [
      'a result ID with a separator',
      () => manager.getEvalSetResult(APP, '../x'),
    ],
  ])(
    'rejects %s before it calls storage',
    async (_name, call: () => Promise<unknown>) => {
      await expect(call()).rejects.toBeInstanceOf(InputValidationError);
      expect(fakeStorage.calls).toEqual([]);
    },
  );
});

describe('createGcsEvalManagersFromUri', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    fakeStorage.existingBuckets.add(BUCKET);
  });

  it('builds both managers for a gs:// bucket URI', async () => {
    const managers = await createGcsEvalManagersFromUri(`gs://${BUCKET}`);
    putEvalSet('case_1');

    await expect(managers.evalSetsManager.listEvalSets(APP)).resolves.toEqual([
      EVAL_SET_ID,
    ]);
    await expect(
      managers.evalSetResultsManager.listEvalSetResults(APP),
    ).resolves.toEqual([]);
    expect(StorageMock).toHaveBeenCalledTimes(1);
    expect(StorageMock).toHaveBeenCalledWith({projectId: 'env-project'});
    expect(
      fakeStorage.calls.filter((call) => call === `bucket.exists:${BUCKET}`),
    ).toHaveLength(1);
  });

  it('uses only the bucket of a URI that has a path', async () => {
    const managers = await createGcsEvalManagersFromUri(
      `gs://${BUCKET}/some/path`,
    );
    putEvalSet('case_1');

    await expect(
      managers.evalSetsManager.getEvalSet(APP, EVAL_SET_ID),
    ).resolves.toBeDefined();
    expect([...fakeStorage.buckets.keys()]).toEqual([BUCKET]);
  });

  it('prefers the project ID from the storage options', async () => {
    await createGcsEvalManagersFromUri(`gs://${BUCKET}`, {
      projectId: 'option-project',
    });

    expect(StorageMock).toHaveBeenCalledWith({projectId: 'option-project'});
  });

  it.each(['s3://test-bucket', 'file:///tmp/evals'])(
    'rejects the unsupported URI %s',
    async (uri) => {
      await expect(createGcsEvalManagersFromUri(uri)).rejects.toThrow(
        /Unsupported eval storage URI scheme '.+:'\. Supported URIs: gs:\/\/<bucket name>\./,
      );
    },
  );

  it.each([
    'gs://user@test-bucket',
    'gs://:secret@test-bucket',
    'gs://user:secret@test-bucket',
    'gs://test-bucket:8080',
    'gs://test-bucket?x=1',
    'gs://test-bucket#frag',
  ])(
    'rejects a gs:// URI with authority, port, query, or fragment (%s)',
    async (uri) => {
      const error = await createGcsEvalManagersFromUri(uri).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error).toMatchObject({
        message:
          'The eval storage URI does not name a valid GCS bucket. Supported URIs: gs://<bucket name>.',
      });
      expect(StorageMock).not.toHaveBeenCalled();
    },
  );

  it('does not repeat the URI when it cannot be parsed', async () => {
    const error = await createGcsEvalManagersFromUri('not a uri secret').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toMatchObject({
      message: expect.not.stringContaining('secret'),
    });
  });

  it('fails when the bucket does not exist', async () => {
    await expect(
      createGcsEvalManagersFromUri('gs://missing-bucket'),
    ).rejects.toThrow(/Bucket `missing-bucket` does not exist/);
  });

  it('fails with a message naming GOOGLE_CLOUD_PROJECT when it is unset', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);

    await expect(
      createGcsEvalManagersFromUri(`gs://${BUCKET}`),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(StorageMock).not.toHaveBeenCalled();
  });
});
