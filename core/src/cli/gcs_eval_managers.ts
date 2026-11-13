/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bucket, StorageOptions} from '@google-cloud/storage';

import {InputValidationError} from '../errors/input_validation_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {
  addEvalCaseToEvalSet,
  createEvalSetResult,
  deleteEvalCaseFromEvalSet,
  EvalSetResult,
  EvalSetResultsManager,
  EvalSetsManager,
  getEvalCaseFromEvalSet,
  normalizeEvalCase,
  parseEvalSetJson,
  parseEvalSetResultJson,
  SaveEvalSetResultParams,
  updateEvalCaseInEvalSet,
  validateEvalId,
} from './cli_eval.js';
import {EvalCase, EvalSet} from './utils/evals.js';
import {validatePathSegment} from './utils/path_validation.js';

const EVAL_SETS_DIR = 'evals/eval_sets';
const EVAL_SET_FILE_EXTENSION = '.evalset.json';
const EVAL_HISTORY_DIR = 'evals/eval_history';
const EVAL_SET_RESULT_FILE_EXTENSION = '.evalset_result.json';
const JSON_CONTENT_TYPE = 'application/json';
const GCS_URI_PROTOCOL = 'gs:';
const SUPPORTED_EVAL_STORAGE_URIS = 'gs://<bucket name>';
const GCS_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const GOOGLE_CLOUD_PROJECT_ENV_VAR = 'GOOGLE_CLOUD_PROJECT';
const HTTP_NOT_FOUND = 404;

/** A bucket and the ADK feature that uses it. */
interface BucketParams {
  bucketName: string;
  storageOptions?: StorageOptions;
  /** The feature named in the error when the storage peer is missing. */
  feature: string;
}

/**
 * Loads the `@google-cloud/storage` optional peer, checks that `bucketName`
 * exists, and returns its bucket handle.
 *
 * @throws {InputValidationError} If the bucket does not exist.
 */
async function loadBucket({
  bucketName,
  storageOptions,
  feature,
}: BucketParams): Promise<Bucket> {
  const {Storage} = await loadOptionalPeer(
    {packageName: '@google-cloud/storage', feature},
    () => import('@google-cloud/storage'),
  );
  const bucket = new Storage(storageOptions).bucket(bucketName);
  const [exists] = await bucket.exists();
  if (!exists) {
    throw new InputValidationError(
      `Bucket \`${bucketName}\` does not exist. Create it before you use it for eval storage.`,
    );
  }
  return bucket;
}

/** Returns whether `e` is a storage client error for an HTTP 404 response. */
function isStorageNotFoundError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    e.code === HTTP_NOT_FOUND
  );
}

/** Reads and writes JSON blobs in one bucket through a cached handle. */
class GcsJsonStore {
  private bucketPromise?: Promise<Bucket>;

  constructor(
    private readonly params: BucketParams,
    bucket?: Bucket,
  ) {
    if (bucket !== undefined) {
      this.bucketPromise = Promise.resolve(bucket);
    }
  }

  /**
   * Resolves the bucket handle, loading the `@google-cloud/storage` optional
   * peer on first use. A failed load is not cached, so a later call retries.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= loadBucket(this.params).catch((e: unknown) => {
      this.bucketPromise = undefined;
      throw e;
    });
    return this.bucketPromise;
  }

  /** Returns whether the blob `blobName` exists. */
  async exists(blobName: string): Promise<boolean> {
    const [exists] = await (await this.getBucket()).file(blobName).exists();
    return exists;
  }

  /** Writes `value` as indented JSON to the blob `blobName`. */
  async writeJson(blobName: string, value: unknown): Promise<void> {
    const bucket = await this.getBucket();
    await bucket.file(blobName).save(JSON.stringify(value, null, 2), {
      contentType: JSON_CONTENT_TYPE,
    });
  }

  /** Reads the blob `blobName` as text, or returns `undefined` if missing. */
  async readText(blobName: string): Promise<string | undefined> {
    const file = (await this.getBucket()).file(blobName);
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
    }
    const [contents] = await file.download();
    return contents.toString('utf-8');
  }

  /**
   * Lists the IDs of the blobs directly under `prefix` that end with
   * `extension`, sorted alphabetically.
   *
   * @throws {NotFoundError} If the storage service answers with a 404.
   */
  async listIds({
    appName,
    prefix,
    extension,
  }: {
    appName: string;
    prefix: string;
    extension: string;
  }): Promise<string[]> {
    try {
      const [files] = await (await this.getBucket()).getFiles({prefix});
      return files
        .map((file) => file.name.slice(prefix.length))
        .filter((name) => name.endsWith(extension) && !name.includes('/'))
        .map((name) => name.slice(0, -extension.length))
        .sort();
    } catch (e: unknown) {
      if (isStorageNotFoundError(e)) {
        throw new NotFoundError(
          `App \`${appName}\` not found in GCS bucket \`${this.params.bucketName}\`.`,
          {cause: e},
        );
      }
      throw e;
    }
  }
}

/**
 * An {@link EvalSetsManager} that stores eval sets in a Google Cloud Storage
 * bucket, at `<appName>/evals/eval_sets/<evalSetId>.evalset.json`.
 *
 * Requires the optional peer dependency `@google-cloud/storage`.
 */
export class GcsEvalSetsManager implements EvalSetsManager {
  private readonly store: GcsJsonStore;

  /**
   * @param bucketName The name of an existing bucket.
   * @param storageOptions Options for the `Storage` client, such as the
   *     project ID.
   */
  constructor(bucketName: string, storageOptions?: StorageOptions);
  /** @internal */
  constructor(
    bucketName: string,
    storageOptions: StorageOptions | undefined,
    bucket: Bucket,
  );
  constructor(
    bucketName: string,
    storageOptions?: StorageOptions,
    bucket?: Bucket,
  ) {
    this.store = new GcsJsonStore(
      {
        bucketName,
        storageOptions,
        feature: 'GcsEvalSetsManager',
      },
      bucket,
    );
  }

  /** Returns the eval set, or `undefined` if its blob does not exist. */
  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    const content = await this.store.readText(
      getEvalSetBlobName(appName, evalSetId),
    );
    return content === undefined
      ? undefined
      : parseEvalSetJson(content, evalSetId);
  }

  /**
   * Creates an empty eval set blob.
   *
   * @throws {InputValidationError} If `evalSetId` is invalid or the eval set
   *     already exists.
   */
  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    validateEvalId('eval set ID', evalSetId);
    const blobName = getEvalSetBlobName(appName, evalSetId);
    if (await this.store.exists(blobName)) {
      throw new InputValidationError(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    }
    logger.debug(`Creating eval set blob \`${blobName}\``);
    const newEvalSet: EvalSet = {
      evalSetId,
      name: evalSetId,
      evalCases: [],
      creationTimestamp: Date.now() / 1000,
    };
    await this.store.writeJson(blobName, newEvalSet);
    return newEvalSet;
  }

  /**
   * Returns the IDs of all eval sets of `appName`, sorted alphabetically.
   *
   * @throws {NotFoundError} If the storage service answers with a 404.
   */
  async listEvalSets(appName: string): Promise<string[]> {
    return this.store.listIds({
      appName,
      prefix: `${getEvalSetsDir(appName)}/`,
      extension: EVAL_SET_FILE_EXTENSION,
    });
  }

  /** Returns the eval case, or `undefined` if it or its eval set is missing. */
  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    return getEvalCaseFromEvalSet(
      await this.getEvalSet(appName, evalSetId),
      evalCaseId,
    );
  }

  /**
   * Adds `evalCase` to an existing eval set.
   *
   * @throws {NotFoundError} If the eval set does not exist.
   * @throws {InputValidationError} If the eval case ID is invalid or exists.
   */
  async addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void> {
    const normalizedCase = normalizeEvalCase(evalCase);
    validateEvalId('Eval Case ID', normalizedCase.evalId);
    const updatedEvalSet = addEvalCaseToEvalSet({
      evalSet: await this.getEvalSet(appName, evalSetId),
      evalSetId,
      evalCase: normalizedCase,
    });
    await this.store.writeJson(
      getEvalSetBlobName(appName, evalSetId),
      updatedEvalSet,
    );
  }

  /**
   * Replaces the eval case that has the ID of `updatedEvalCase`.
   *
   * @throws {NotFoundError} If the eval set or the eval case is not found.
   */
  async updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void> {
    const normalizedCase = normalizeEvalCase(updatedEvalCase);
    const updatedEvalSet = updateEvalCaseInEvalSet({
      evalSet: await this.getEvalSet(appName, evalSetId),
      evalSetId,
      evalCase: normalizedCase,
    });
    await this.store.writeJson(
      getEvalSetBlobName(appName, evalSetId),
      updatedEvalSet,
    );
  }

  /**
   * Deletes an eval case.
   *
   * @throws {NotFoundError} If the eval set or the eval case is not found.
   */
  async deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void> {
    const updatedEvalSet = deleteEvalCaseFromEvalSet({
      evalSet: await this.getEvalSet(appName, evalSetId),
      evalSetId,
      evalCaseId,
    });
    await this.store.writeJson(
      getEvalSetBlobName(appName, evalSetId),
      updatedEvalSet,
    );
  }
}

/**
 * An {@link EvalSetResultsManager} that stores eval set results in a Google
 * Cloud Storage bucket, at
 * `<appName>/evals/eval_history/<evalSetResultId>.evalset_result.json`.
 *
 * Requires the optional peer dependency `@google-cloud/storage`.
 */
export class GcsEvalSetResultsManager implements EvalSetResultsManager {
  private readonly store: GcsJsonStore;

  /**
   * @param bucketName The name of an existing bucket.
   * @param storageOptions Options for the `Storage` client, such as the
   *     project ID.
   */
  constructor(bucketName: string, storageOptions?: StorageOptions);
  /** @internal */
  constructor(
    bucketName: string,
    storageOptions: StorageOptions | undefined,
    bucket: Bucket,
  );
  constructor(
    bucketName: string,
    storageOptions?: StorageOptions,
    bucket?: Bucket,
  ) {
    this.store = new GcsJsonStore(
      {
        bucketName,
        storageOptions,
        feature: 'GcsEvalSetResultsManager',
      },
      bucket,
    );
  }

  /** Creates and saves a new {@link EvalSetResult} for `evalCaseResults`. */
  async saveEvalSetResult({
    appName,
    evalSetId,
    evalCaseResults,
  }: SaveEvalSetResultParams): Promise<EvalSetResult> {
    validatePathSegment(appName, 'appName');
    validatePathSegment(evalSetId, 'evalSetId');
    const evalSetResult = createEvalSetResult({
      appName,
      evalSetId,
      evalCaseResults,
    });
    const blobName = getEvalSetResultBlobName(
      appName,
      evalSetResult.evalSetResultName,
    );
    logger.debug(`Writing eval result to blob \`${blobName}\``);
    await this.store.writeJson(blobName, evalSetResult);
    return evalSetResult;
  }

  /**
   * Returns the {@link EvalSetResult} for `appName` and `evalSetResultId`.
   *
   * @throws {NotFoundError} If the result blob does not exist.
   */
  async getEvalSetResult(
    appName: string,
    evalSetResultId: string,
  ): Promise<EvalSetResult> {
    const content = await this.store.readText(
      getEvalSetResultBlobName(appName, evalSetResultId),
    );
    if (content === undefined) {
      throw new NotFoundError(
        `Eval set result \`${evalSetResultId}\` not found.`,
      );
    }
    return parseEvalSetResultJson(content);
  }

  /**
   * Returns the IDs of all saved eval set results for `appName`, sorted
   * alphabetically.
   *
   * @throws {NotFoundError} If the storage service answers with a 404.
   */
  async listEvalSetResults(appName: string): Promise<string[]> {
    return this.store.listIds({
      appName,
      prefix: `${getEvalHistoryDir(appName)}/`,
      extension: EVAL_SET_RESULT_FILE_EXTENSION,
    });
  }
}

function getEvalSetsDir(appName: string): string {
  validatePathSegment(appName, 'appName');
  return `${appName}/${EVAL_SETS_DIR}`;
}

function getEvalSetBlobName(appName: string, evalSetId: string): string {
  validatePathSegment(evalSetId, 'evalSetId');
  validateEvalId('eval set ID', evalSetId);
  return `${getEvalSetsDir(appName)}/${evalSetId}${EVAL_SET_FILE_EXTENSION}`;
}

function getEvalHistoryDir(appName: string): string {
  validatePathSegment(appName, 'appName');
  return `${appName}/${EVAL_HISTORY_DIR}`;
}

function getEvalSetResultBlobName(
  appName: string,
  evalSetResultId: string,
): string {
  validatePathSegment(evalSetResultId, 'evalSetResultId');
  return `${getEvalHistoryDir(appName)}/${evalSetResultId}${EVAL_SET_RESULT_FILE_EXTENSION}`;
}

/** The pair of GCS eval managers that {@link createGcsEvalManagersFromUri} builds. */
export interface GcsEvalManagers {
  readonly evalSetsManager: GcsEvalSetsManager;
  readonly evalSetResultsManager: GcsEvalSetResultsManager;
}

/**
 * Returns the bucket name of a `gs://<bucket name>[/path]` URI. Any path is
 * ignored.
 *
 * @throws {InputValidationError} If the URI is malformed, uses another scheme,
 *     or names an invalid bucket. The message never repeats the URI.
 */
function parseGcsBucketName(evalStorageUri: string): string {
  let url: URL;
  try {
    url = new URL(evalStorageUri);
  } catch (e: unknown) {
    throw new InputValidationError(
      `The eval storage URI is not a valid URI. Supported URIs: ${SUPPORTED_EVAL_STORAGE_URIS}.`,
      {cause: e},
    );
  }
  if (url.protocol !== GCS_URI_PROTOCOL) {
    throw new InputValidationError(
      `Unsupported eval storage URI scheme '${url.protocol}'. Supported URIs: ${SUPPORTED_EVAL_STORAGE_URIS}.`,
    );
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !GCS_BUCKET_NAME_PATTERN.test(url.hostname)
  ) {
    throw new InputValidationError(
      `The eval storage URI does not name a valid GCS bucket. Supported URIs: ${SUPPORTED_EVAL_STORAGE_URIS}.`,
    );
  }
  return url.hostname;
}

/**
 * Creates a {@link GcsEvalSetsManager} and a {@link GcsEvalSetResultsManager}
 * for the bucket that `evalStorageUri` names.
 *
 * The project comes from `storageOptions.projectId`, or else from the
 * `GOOGLE_CLOUD_PROJECT` environment variable. The bucket must exist.
 *
 * @param evalStorageUri A URI of the form `gs://<bucket name>`. When the URI
 *     has a path, only the bucket is used.
 * @param storageOptions Options for the `Storage` client.
 * @returns The two managers.
 * @throws {InputValidationError} If the URI is not supported, the project is
 *     not set, or the bucket does not exist.
 */
export async function createGcsEvalManagersFromUri(
  evalStorageUri: string,
  storageOptions?: StorageOptions,
): Promise<GcsEvalManagers> {
  const bucketName = parseGcsBucketName(evalStorageUri);
  const projectId =
    storageOptions?.projectId ?? process.env[GOOGLE_CLOUD_PROJECT_ENV_VAR];
  if (!projectId) {
    throw new InputValidationError(
      `GCS eval storage needs a Google Cloud project. Set the ${GOOGLE_CLOUD_PROJECT_ENV_VAR} environment variable.`,
    );
  }
  const options: StorageOptions = {...storageOptions, projectId};
  const bucket = await loadBucket({
    bucketName,
    storageOptions: options,
    feature: 'GCS eval storage',
  });
  return {
    evalSetsManager: new GcsEvalSetsManager(bucketName, options, bucket),
    evalSetResultsManager: new GcsEvalSetResultsManager(
      bucketName,
      options,
      bucket,
    ),
  };
}
