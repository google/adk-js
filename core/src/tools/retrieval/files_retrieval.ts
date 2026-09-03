/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {
  LlamaIndexRetrieval,
  LlamaIndexRetriever,
} from './llama_index_retrieval.js';

/**
 * The `llamaindex` surface `FilesRetrieval.create` uses.
 *
 * Declared structurally and imported through a non-literal specifier so that
 * `llamaindex` stays optional: a project that never builds a `FilesRetrieval`
 * neither installs it nor compiles against it. adk-python leaves the same
 * dependency to the `llama-index` extra.
 */
interface LlamaIndexModule {
  VectorStoreIndex: {
    fromDocuments(documents: unknown[]): Promise<{
      asRetriever(): LlamaIndexRetriever;
    }>;
  };
}

/** The `@llamaindex/readers/directory` surface `FilesRetrieval.create` uses. */
interface DirectoryReaderModule {
  SimpleDirectoryReader: new () => {
    loadData(params: {directoryPath: string}): Promise<unknown[]>;
  };
}

const LLAMA_INDEX_MODULE = 'llamaindex';
const DIRECTORY_READER_MODULE = '@llamaindex/readers/directory';

async function importOptional<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    throw new Error(
      `FilesRetrieval needs the optional package '${specifier}', which is ` +
        `not installed. Install '${LLAMA_INDEX_MODULE}' and ` +
        `'@llamaindex/readers', or build the retriever yourself and pass it ` +
        'to LlamaIndexRetrieval.',
      {cause},
    );
  }
}

/** Parameters shared by the `FilesRetrieval` constructor and `create`. */
export interface FilesRetrievalParams {
  name: string;
  description: string;
  /** The directory whose files are indexed. */
  inputDir: string;
}

/** Parameters for the `FilesRetrieval` constructor. */
export interface FilesRetrievalConstructorParams extends FilesRetrievalParams {
  /** A retriever already built over `inputDir`. */
  retriever: LlamaIndexRetriever;
}

/**
 * A retrieval tool over the files in a local directory.
 *
 * Ported from adk-python `src/google/adk/tools/retrieval/files_retrieval.py`
 * at ref `v0.1.0`.
 *
 * adk-python reads the directory and builds the index inside `__init__`.
 * Both steps are asynchronous in LlamaIndexTS, so they live in the static
 * `create` instead; the constructor takes the finished retriever, which also
 * lets a caller supply one built some other way.
 *
 * @example
 * ```ts
 * const tool = await FilesRetrieval.create({
 *   name: 'docs',
 *   description: 'Company documentation.',
 *   inputDir: './docs',
 * });
 * ```
 */
export class FilesRetrieval extends LlamaIndexRetrieval {
  readonly inputDir: string;

  constructor(params: FilesRetrievalConstructorParams) {
    super({
      name: params.name,
      description: params.description,
      retriever: params.retriever,
    });
    this.inputDir = params.inputDir;
  }

  /**
   * Indexes every file under `inputDir` and returns a tool that retrieves
   * from it.
   *
   * Requires the optional `llamaindex` and `@llamaindex/readers` packages,
   * and a configured LlamaIndex embedding model.
   */
  static async create(params: FilesRetrievalParams): Promise<FilesRetrieval> {
    // adk-python `print`s this line; the equivalent here is the ADK logger.
    logger.info(`Loading data from ${params.inputDir}`);

    const {SimpleDirectoryReader} = await importOptional<DirectoryReaderModule>(
      DIRECTORY_READER_MODULE,
    );
    const {VectorStoreIndex} =
      await importOptional<LlamaIndexModule>(LLAMA_INDEX_MODULE);

    const documents = await new SimpleDirectoryReader().loadData({
      directoryPath: params.inputDir,
    });
    const index = await VectorStoreIndex.fromDocuments(documents);

    return new FilesRetrieval({...params, retriever: index.asRetriever()});
  }
}
