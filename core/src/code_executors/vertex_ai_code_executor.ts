/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {experimental} from '../utils/experimental.js';
import {guessMimeType} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult, File} from './code_execution_utils.js';

const SUPPORTED_IMAGE_TYPES = ['png', 'jpg', 'jpeg'];
const SUPPORTED_DATA_FILE_TYPES = ['csv'];

const IMPORTED_LIBRARIES = `import io
import math
import re

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy

def crop(s: str, max_chars: int = 64) -> str:
  """Crops a string to max_chars characters."""
  return s[: max_chars - 3] + '...' if len(s) > max_chars else s


def explore_df(df: pd.DataFrame) -> None:
  """Prints some information about a pandas DataFrame."""

  with pd.option_context(
      'display.max_columns', None, 'display.expand_frame_repr', False
  ):
    # Print the column names to never encounter KeyError when selecting one.
    df_dtypes = df.dtypes

    # Obtain information about data types and missing values.
    df_nulls = (len(df) - df.isnull().sum()).apply(
        lambda x: f'{x} / {df.shape[0]} non-null'
    )

    # Explore unique total values in columns using \`.unique()\`.
    df_unique_count = df.apply(lambda x: len(x.unique()))

    # Explore unique values in columns using \`.unique()\`.
    df_unique = df.apply(lambda x: crop(str(list(x.unique()))))

    df_info = pd.concat(
        (
            df_dtypes.rename('Dtype'),
            df_nulls.rename('Non-Null Count'),
            df_unique_count.rename('Unique Values Count'),
            df_unique.rename('Unique Values'),
        ),
        axis=1,
    )
    df_info.index.name = 'Columns'
    print(f"""Total rows: {df.shape[0]}
Total columns: {df.shape[1]}

{df_info}""")`;

const EXTENSION_RESOURCE_NAME_PATTERN =
  /^projects\/([^/]+)\/locations\/([^/]+)\/extensions\/([^/]+)$/;

function padTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTimestampPrefix(date: Date): string {
  const year = date.getFullYear();
  const month = padTwoDigits(date.getMonth() + 1);
  const day = padTwoDigits(date.getDate());
  const hours = padTwoDigits(date.getHours());
  const minutes = padTwoDigits(date.getMinutes());
  const seconds = padTwoDigits(date.getSeconds());
  return `${year}${month}${day}_${hours}${minutes}${seconds}_`;
}

/**
 * Prepends the standard data-science imports and helper functions to `code`.
 */
function getCodeWithImports(code: string): string {
  return `\n${IMPORTED_LIBRARIES}\n\n${code}\n`;
}

/**
 * An input file passed to the Vertex AI Code Interpreter extension.
 */
export interface CodeInterpreterInputFile {
  /** The name of the input file. */
  name: string;
  /** The base64-encoded contents of the input file. */
  contents: string;
}

/**
 * Operation parameters passed to the Vertex AI Code Interpreter `execute`
 * operation.
 */
export interface CodeInterpreterOperationParams {
  /** The Python code to execute. */
  code: string;
  /** Optional input files made available to the execution environment. */
  files?: CodeInterpreterInputFile[];
  /** Optional session identifier for stateful code execution. */
  session_id?: string;
}

/**
 * An output file returned by the Vertex AI Code Interpreter extension.
 */
export interface CodeInterpreterOutputFile {
  /** The name of the output file. */
  name: string;
  /** The base64-encoded contents of the output file. */
  contents: string;
}

/**
 * The response structure returned by the Vertex AI Code Interpreter extension.
 */
export interface CodeInterpreterResponse {
  /** Standard output from the code execution. */
  execution_result?: string;
  /** Standard error from the code execution. */
  execution_error?: string;
  /** Files generated during the code execution. */
  output_files?: CodeInterpreterOutputFile[];
}

/**
 * Parameters passed to {@link CodeInterpreterExtension.execute}.
 */
export interface CodeInterpreterExecuteParams {
  /** The operation identifier (`'execute'`). */
  operationId: string;
  /** The operation parameters (`code`, optional `files`, optional `session_id`). */
  operationParams: CodeInterpreterOperationParams;
}

/**
 * Client interface for executing operations on a Vertex AI Code Interpreter
 * extension.
 */
export interface CodeInterpreterExtension {
  /** The full resource name of the extension, if available. */
  resourceName?: string;
  /** Executes an operation on the extension. */
  execute(
    params: CodeInterpreterExecuteParams,
  ): Promise<CodeInterpreterResponse>;
}

/**
 * Configuration options for {@link VertexAiCodeExecutor}.
 */
export interface VertexAiCodeExecutorOptions {
  /**
   * If set, load the existing resource name of the code interpreter extension
   * instead of creating a new one.
   * Format: `projects/123/locations/us-central1/extensions/456`
   */
  resourceName?: string;
  /**
   * Optional injected Code Interpreter extension client. When omitted, a
   * default client backed by `GoogleAuth` and the Vertex AI Extensions REST
   * API is created on first execution.
   */
  codeInterpreterExtension?: CodeInterpreterExtension;
  /**
   * Whether to extract and process data files from the model request.
   */
  optimizeDataFile?: boolean;
  /**
   * Whether the code executor maintains execution state across turns.
   */
  stateful?: boolean;
  /**
   * The number of attempts to retry on consecutive code execution errors.
   */
  errorRetryAttempts?: number;
  /**
   * The list of enclosing delimiters to identify code blocks.
   */
  codeBlockDelimiters?: Array<[string, string]>;
  /**
   * The delimiters to format the code execution result.
   */
  executionResultDelimiters?: [string, string];
}

interface ExtensionImportOperationResponse {
  name?: string;
  response?: {name?: string};
}

interface ExtensionExecuteEnvelope extends CodeInterpreterResponse {
  output?: {content?: string};
}

class VertexAiExtensionRestClient implements CodeInterpreterExtension {
  readonly resourceName: string;
  private readonly location: string;
  private readonly auth: GoogleAuth;

  constructor(resourceName: string, auth?: GoogleAuth) {
    const match = EXTENSION_RESOURCE_NAME_PATTERN.exec(resourceName);
    if (!match) {
      throw new Error(`Extension resource name ${resourceName} is not valid.`);
    }
    this.resourceName = resourceName;
    this.location = match[2];
    this.auth =
      auth ??
      new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
  }

  static async fromHub(
    hubExtensionId: string,
    auth?: GoogleAuth,
  ): Promise<VertexAiExtensionRestClient> {
    const envProject =
      process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
    const project =
      envProject && envProject.length > 0 ? envProject : undefined;
    const envLocation = process.env.GOOGLE_CLOUD_LOCATION;
    const location =
      envLocation && envLocation.length > 0 ? envLocation : 'us-central1';
    if (!project) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT environment variable must be set when resourceName is not provided for VertexAiCodeExecutor.',
      );
    }
    const googleAuth =
      auth ??
      new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    const token = await googleAuth.getAccessToken();
    const baseUrl = `https://${location}-aiplatform.googleapis.com/v1beta1`;
    const importUrl = `${baseUrl}/projects/${project}/locations/${location}/extensions:import`;

    const response = await fetch(importUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {'Authorization': `Bearer ${token}`} : {}),
      },
      body: JSON.stringify({
        displayName: 'Code Interpreter',
        description: 'Code Interpreter Extension',
        manifest: {
          name: hubExtensionId,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to import Vertex AI extension (${response.status}): ${errorText}`,
      );
    }

    // Cast external JSON response at the HTTP boundary.
    const operationData =
      (await response.json()) as ExtensionImportOperationResponse;
    const createdResourceName = operationData.response?.name;
    if (!createdResourceName) {
      throw new Error(
        'Vertex AI extension import did not return a resource name.',
      );
    }
    return new VertexAiExtensionRestClient(createdResourceName, googleAuth);
  }

  async execute(
    params: CodeInterpreterExecuteParams,
  ): Promise<CodeInterpreterResponse> {
    const token = await this.auth.getAccessToken();
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/${this.resourceName}:execute`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {'Authorization': `Bearer ${token}`} : {}),
      },
      body: JSON.stringify({
        operationId: params.operationId,
        operationParams: params.operationParams,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Vertex AI Code Interpreter execution failed (${response.status}): ${errorText}`,
      );
    }

    // Cast external JSON response at the HTTP boundary.
    const payload = (await response.json()) as ExtensionExecuteEnvelope;
    if (payload.output?.content) {
      return JSON.parse(payload.output.content) as CodeInterpreterResponse;
    }
    return payload;
  }
}

/**
 * A code executor that uses Vertex AI Code Interpreter Extension to execute
 * code.
 */
@experimental
export class VertexAiCodeExecutor extends BaseCodeExecutor {
  /**
   * If set, load the existing resource name of the code interpreter extension
   * instead of creating a new one.
   * Format: `projects/123/locations/us-central1/extensions/456`
   */
  resourceName?: string;

  private codeInterpreterExtension?: CodeInterpreterExtension;

  /**
   * Initializes the VertexAiCodeExecutor.
   *
   * @param options Configuration options for the VertexAiCodeExecutor.
   */
  constructor(options: VertexAiCodeExecutorOptions = {}) {
    super();
    if (options.optimizeDataFile !== undefined) {
      this.optimizeDataFile = options.optimizeDataFile;
    }
    if (options.stateful !== undefined) {
      this.stateful = options.stateful;
    }
    if (options.errorRetryAttempts !== undefined) {
      this.errorRetryAttempts = options.errorRetryAttempts;
    }
    if (options.codeBlockDelimiters !== undefined) {
      this.codeBlockDelimiters = options.codeBlockDelimiters;
    }
    if (options.executionResultDelimiters !== undefined) {
      this.executionResultDelimiters = options.executionResultDelimiters;
    }

    if (options.resourceName !== undefined) {
      if (!EXTENSION_RESOURCE_NAME_PATTERN.test(options.resourceName)) {
        throw new Error(
          `Extension resource name ${options.resourceName} is not valid.`,
        );
      }
      this.resourceName = options.resourceName;
    } else if (process.env.CODE_INTERPRETER_EXTENSION_NAME) {
      const envResourceName = process.env.CODE_INTERPRETER_EXTENSION_NAME;
      if (EXTENSION_RESOURCE_NAME_PATTERN.test(envResourceName)) {
        this.resourceName = envResourceName;
      } else {
        logger.warn(`Extension resource name ${envResourceName} is not valid.`);
      }
    }

    this.codeInterpreterExtension = options.codeInterpreterExtension;
  }

  /**
   * Executes code and returns the code execution result.
   */
  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code, inputFiles, executionId} = params.codeExecutionInput;
    const codeWithImports = getCodeWithImports(code);
    const codeExecutionResult = await this.executeCodeInterpreter(
      codeWithImports,
      inputFiles,
      executionId,
    );

    const savedFiles: File[] = [];
    let fileCount = 0;
    const fileNamePrefix = formatTimestampPrefix(new Date());
    for (const outputFile of codeExecutionResult.output_files ?? []) {
      const fileType = outputFile.name.split('.').pop() ?? '';
      const fileName = `${fileNamePrefix}${fileCount}.${fileType}`;
      if (SUPPORTED_IMAGE_TYPES.includes(fileType)) {
        fileCount += 1;
        savedFiles.push({
          name: `plot_${fileName}`,
          content: outputFile.contents,
          mimeType: `image/${fileType}`,
        });
      } else if (SUPPORTED_DATA_FILE_TYPES.includes(fileType)) {
        fileCount += 1;
        savedFiles.push({
          name: `data_${fileName}`,
          content: outputFile.contents,
          mimeType: `text/${fileType}`,
        });
      } else {
        const mimeType = guessMimeType(fileName);
        savedFiles.push({
          name: fileName,
          content: outputFile.contents,
          mimeType,
        });
      }
    }

    return {
      stdout: codeExecutionResult.execution_result ?? '',
      stderr: codeExecutionResult.execution_error ?? '',
      outputFiles: savedFiles,
    };
  }

  private async executeCodeInterpreter(
    code: string,
    inputFiles?: File[],
    sessionId?: string,
  ): Promise<CodeInterpreterResponse> {
    const extension = await this.getCodeInterpreterExtension();
    const operationParams: CodeInterpreterOperationParams = {code};
    if (inputFiles && inputFiles.length > 0) {
      operationParams.files = inputFiles.map((f) => ({
        name: f.name,
        contents: f.content,
      }));
    }
    if (sessionId) {
      operationParams.session_id = sessionId;
    }
    return extension.execute({
      operationId: 'execute',
      operationParams,
    });
  }

  private async getCodeInterpreterExtension(): Promise<CodeInterpreterExtension> {
    if (!this.codeInterpreterExtension) {
      if (!this.resourceName) {
        logger.debug(
          'No CODE_INTERPRETER_EXTENSION_NAME found in the environment. Creating a new one.',
        );
        const client =
          await VertexAiExtensionRestClient.fromHub('code_interpreter');
        this.resourceName = client.resourceName;
        process.env.CODE_INTERPRETER_EXTENSION_NAME = client.resourceName;
        this.codeInterpreterExtension = client;
      } else {
        this.codeInterpreterExtension = new VertexAiExtensionRestClient(
          this.resourceName,
        );
      }
    }
    return this.codeInterpreterExtension;
  }
}
