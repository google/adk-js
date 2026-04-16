/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {cloneDeep} from 'lodash-es';

import {isBaseCodeExecutor} from '../../code_executors/base_code_executor.js';
import {isBuiltInCodeExecutor} from '../../code_executors/built_in_code_executor.js';
import {
  buildCodeExecutionResultPart,
  buildExecutableCodePart,
  CodeExecutionLanguage,
  CodeExecutionResult,
  convertCodeExecutionParts,
  extractCodeAndTruncateContent,
  File,
} from '../../code_executors/code_execution_utils.js';
import {CodeExecutorContext} from '../../code_executors/code_executor_context.js';
import {createEvent, Event} from '../../events/event.js';
import {createEventActions} from '../../events/event_actions.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {State} from '../../sessions/state.js';
import {base64Decode} from '../../utils/env_aware_utils.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/**
 * Processes code execution requests.
 */
export class CodeExecutionRequestProcessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    if (!isLlmAgent(invocationContext.agent)) {
      return;
    }

    if (!invocationContext.agent.codeExecutor) {
      return;
    }

    for await (const event of runPreProcessor(invocationContext, llmRequest)) {
      yield event;
    }

    if (!isBaseCodeExecutor(invocationContext.agent.codeExecutor)) {
      return;
    }

    for (const content of llmRequest.contents) {
      const delimeters: [string, string] = invocationContext.agent.codeExecutor
        .codeBlockDelimiters.length
        ? invocationContext.agent.codeExecutor.codeBlockDelimiters[0]
        : ['', ''];

      convertCodeExecutionParts(
        content,
        delimeters,
        invocationContext.agent.codeExecutor.executionResultDelimiters,
      );
    }
  }
}

/**
 * Map of MIME types to data file utilities
 */
const DATA_FILE_UTIL_MAP: Record<
  string,
  {
    extension: string;
    loaderCodeTemplate: string;
  }
> = {
  'text/csv': {
    extension: '.csv',
    loaderCodeTemplate: "pd.read_csv('{filename}')",
  },
};

/**
 * Helper library for data file exploration
 */
const DATA_FILE_HELPER_LIB = `
import pandas as pd

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

{df_info}""")
`;

/**
 * Processor for code execution responses.
 */
export class CodeExecutionResponseProcessor implements BaseLlmResponseProcessor {
  /**
   * Processes the LLM response asynchronously.
   *
   * @param invocationContext The invocation context
   * @param llmResponse The LLM response to process
   * @returns An async generator yielding events
   */
  async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, unknown> {
    // Skip if the response is partial (streaming)
    if (llmResponse.partial) {
      return;
    }

    // Run the post-processor with standard generator approach
    for await (const event of runPostProcessor(
      invocationContext,
      llmResponse,
    )) {
      yield event;
    }
  }
}

/**
 * The exported response processor instance.
 */
export const responseProcessor = new CodeExecutionResponseProcessor();

/**
 * Pre-processes the user message by adding the user message to the execution
 * environment.
 *
 * @param invocationContext The invocation context
 * @param llmRequest The LLM request to process
 * @returns An async generator yielding events
 */
async function* runPreProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
): AsyncGenerator<Event, void, unknown> {
  const agent = invocationContext.agent;

  if (!isLlmAgent(agent)) {
    return;
  }

  const codeExecutor = agent.codeExecutor;

  if (!codeExecutor || !isBaseCodeExecutor(codeExecutor)) {
    return;
  }

  if (isBuiltInCodeExecutor(codeExecutor)) {
    codeExecutor.processLlmRequest(llmRequest);
    return;
  }

  if (!codeExecutor.optimizeDataFile) {
    return;
  }

  const codeExecutorContext = new CodeExecutorContext(
    new State(invocationContext.session.state),
  );

  // Skip if the error count exceeds the max retry attempts
  if (
    codeExecutorContext.getErrorCount(invocationContext.invocationId) >=
    codeExecutor.errorRetryAttempts
  ) {
    return;
  }

  // [Step 1] Extract data files from the session_history and store them in
  // memory Meanwhile, mutate the inline data file to text part in session
  // history from all turns
  const allInputFiles = extractAndReplaceInlineFiles(
    codeExecutorContext,
    llmRequest,
  );

  // [Step 2] Run explore_df code on the data files from the current turn
  // We only need to explore the new data files because the previous data files
  // should already be explored and cached in the code execution runtime
  const processedFileNames = new Set(
    codeExecutorContext.getProcessedFileNames(),
  );
  const filesToProcess = allInputFiles.filter(
    (f) => !processedFileNames.has(f.name),
  );

  for (const file of filesToProcess) {
    const codeStr = getDataFilePreprocessingCode(file);

    // Skip for unsupported file or executor types
    if (!codeStr) {
      return;
    }

    // Emit the code to execute, and add it to the LLM request
    const codeContent: Content = {
      role: 'model',
      parts: [
        {text: `Processing input file: \`${file.name}\``},
        buildExecutableCodePart(codeStr),
      ],
    };

    llmRequest.contents.push(cloneDeep(codeContent)!);

    yield createEvent({
      invocationId: invocationContext.invocationId,
      author: agent.name,
      branch: invocationContext.branch,
      content: codeContent,
    });

    const executionId = getOrSetExecutionId(
      invocationContext,
      codeExecutorContext,
    );
    const codeExecutionResult = await codeExecutor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: codeStr,
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [file],
        executionId,
      },
    });

    // Update the processing results to code executor context
    codeExecutorContext.updateCodeExecutionResult({
      invocationId: invocationContext.invocationId,
      code: codeStr,
      resultStdout: codeExecutionResult.stdout,
      resultStderr: codeExecutionResult.stderr,
    });

    codeExecutorContext.addProcessedFileNames([file.name]);

    // Emit the execution result, and add it to the LLM request
    const executionResultEvent = await postProcessCodeExecutionResult(
      invocationContext,
      codeExecutorContext,
      codeExecutionResult,
    );

    yield executionResultEvent;
    llmRequest.contents.push(cloneDeep(executionResultEvent.content)!);
  }
}

/**
 * Post-processes the model response by extracting and executing the first code
 * block.
 *
 * @param invocationContext The invocation context
 * @param llmResponse The LLM response to process
 * @returns An async generator yielding events
 */
async function* runPostProcessor(
  invocationContext: InvocationContext,
  llmResponse: LlmResponse,
): AsyncGenerator<Event, void, unknown> {
  const agent = invocationContext.agent;

  if (!isLlmAgent(agent)) {
    return;
  }

  const codeExecutor = agent.codeExecutor;

  if (!codeExecutor || !isBaseCodeExecutor(codeExecutor)) {
    return;
  }

  if (!llmResponse || !llmResponse.content) {
    return;
  }

  if (isBuiltInCodeExecutor(codeExecutor)) {
    return;
  }

  const codeExecutorContext = new CodeExecutorContext(
    new State(invocationContext.session.state),
  );

  // Skip if the error count exceeds the max retry attempts
  if (
    codeExecutorContext.getErrorCount(invocationContext.invocationId) >=
    codeExecutor.errorRetryAttempts
  ) {
    return;
  }

  // [Step 1] Extract code from the model predict response and truncate the
  // content to the part with the first code block
  const responseContent = llmResponse.content;
  const codeStr = extractCodeAndTruncateContent(
    responseContent,
    codeExecutor.codeBlockDelimiters,
  );

  // Terminal state: no code to execute
  if (!codeStr) {
    return;
  }

  // [Step 2] Executes the code and emit 2 Events for code and execution result
  yield createEvent({
    invocationId: invocationContext.invocationId,
    author: agent.name,
    branch: invocationContext.branch,
    content: responseContent,
  });

  const executionId = getOrSetExecutionId(
    invocationContext,
    codeExecutorContext,
  );
  const codeExecutionResult = await codeExecutor.executeCode({
    invocationContext,
    codeExecutionInput: {
      code: codeStr,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: codeExecutorContext.getInputFiles(),
      executionId,
    },
  });

  codeExecutorContext.updateCodeExecutionResult({
    invocationId: invocationContext.invocationId,
    code: codeStr,
    resultStdout: codeExecutionResult.stdout,
    resultStderr: codeExecutionResult.stderr,
  });

  yield await postProcessCodeExecutionResult(
    invocationContext,
    codeExecutorContext,
    codeExecutionResult,
  );

  // [Step 3] Skip processing the original model response
  // to continue code generation loop
  llmResponse.content = undefined;
}

/**
 * Extracts and replaces inline files with file names in the LLM request.
 *
 * @param codeExecutorContext The code executor context
 * @param llmRequest The LLM request to process
 * @returns A list of input files
 */
function extractAndReplaceInlineFiles(
  codeExecutorContext: CodeExecutorContext,
  llmRequest: LlmRequest,
): File[] {
  const allInputFiles = codeExecutorContext.getInputFiles();
  const savedFileNames = new Set(allInputFiles.map((f) => f.name));

  // [Step 1] Process input files from LlmRequest and cache them in CodeExecutor
  for (let i = 0; i < llmRequest.contents.length; i++) {
    const content = llmRequest.contents[i];

    // Only process the user message
    if (content.role !== 'user' || !content.parts) {
      continue;
    }

    for (let j = 0; j < content.parts.length; j++) {
      const part = content.parts[j] as Part;
      const mimeType = part.inlineData?.mimeType;

      // Skip if the inline data is not supported
      if (!mimeType || !part.inlineData || !DATA_FILE_UTIL_MAP[mimeType]) {
        continue;
      }

      // Replace the inline data file with a file name placeholder
      const fileName = `data_${i + 1}_${j + 1}${DATA_FILE_UTIL_MAP[mimeType].extension}`;

      part.text = `\nAvailable file: \`${fileName}\`\n`;

      // Add the inline data as input file to the code executor context
      const file: File = {
        name: fileName,
        content: base64Decode(part.inlineData.data!),
        mimeType,
      };

      if (!savedFileNames.has(fileName)) {
        codeExecutorContext.addInputFiles([file]);
        allInputFiles.push(file);
      }
    }
  }

  return allInputFiles;
}

/**
 * Gets or sets the execution ID for stateful code execution.
 *
 * @param invocationContext The invocation context
 * @param codeExecutorContext The code executor context
 * @returns The execution ID or undefined if not stateful
 */
function getOrSetExecutionId(
  invocationContext: InvocationContext,
  codeExecutorContext: CodeExecutorContext,
): string | undefined {
  const agent = invocationContext.agent;

  if (!isLlmAgent(agent) || !agent.codeExecutor?.stateful) {
    return undefined;
  }

  let executionId = codeExecutorContext.getExecutionId();

  if (!executionId) {
    executionId = invocationContext.session.id;
    codeExecutorContext.setExecutionId(executionId);
  }

  return executionId;
}

/**
 * Post-processes the code execution result and emits an Event.
 *
 * @param invocationContext The invocation context
 * @param codeExecutorContext The code executor context
 * @param codeExecutionResult The code execution result
 * @returns The event with the code execution result
 */
async function postProcessCodeExecutionResult(
  invocationContext: InvocationContext,
  codeExecutorContext: CodeExecutorContext,
  codeExecutionResult: CodeExecutionResult,
): Promise<Event> {
  if (!invocationContext.artifactService) {
    throw new Error('Artifact service is not initialized.');
  }

  const resultContent: Content = {
    role: 'model',
    parts: [buildCodeExecutionResultPart(codeExecutionResult)],
  };

  const eventActions = createEventActions({
    stateDelta: codeExecutorContext.getStateDelta(),
  });

  // Handle code execution error retry
  if (codeExecutionResult.stderr) {
    codeExecutorContext.incrementErrorCount(invocationContext.invocationId);
  } else {
    codeExecutorContext.resetErrorCount(invocationContext.invocationId);
  }

  // Handle output files
  for (const outputFile of codeExecutionResult.outputFiles) {
    const version = await invocationContext.artifactService.saveArtifact({
      appName: invocationContext.appName || '',
      userId: invocationContext.userId || '',
      sessionId: invocationContext.session.id,
      filename: outputFile.name,
      artifact: {
        inlineData: {data: outputFile.content, mimeType: outputFile.mimeType},
      },
    });

    eventActions.artifactDelta[outputFile.name] = version;
  }

  return createEvent({
    invocationId: invocationContext.invocationId,
    author: invocationContext.agent.name,
    branch: invocationContext.branch,
    content: resultContent,
    actions: eventActions,
  });
}

/**
 * Returns the code to explore the data file.
 *
 * @param file The file to explore
 * @returns The code to explore the data file or undefined if not supported
 */
function getDataFilePreprocessingCode(file: File): string | undefined {
  /**
   * Gets a normalized file name.
   *
   * @param fileName The file name to normalize
   * @returns The normalized file name
   */
  function getNormalizedFileName(fileName: string): string {
    const [varName] = fileName.split('.');

    // Replace non-alphanumeric characters with underscores
    let normalizedName = varName.replace(/[^a-zA-Z0-9_]/g, '_');

    // If the filename starts with a digit, prepend an underscore
    if (/^\d/.test(normalizedName)) {
      normalizedName = '_' + normalizedName;
    }

    return normalizedName;
  }

  if (!DATA_FILE_UTIL_MAP[file.mimeType]) {
    return undefined;
  }

  const varName = getNormalizedFileName(file.name);
  const loaderCode = DATA_FILE_UTIL_MAP[
    file.mimeType
  ].loaderCodeTemplate.replace('{filename}', file.name);

  return `
${DATA_FILE_HELPER_LIB}

# Load the dataframe.
${varName} = ${loaderCode}

# Use \`explore_df\` to guide my analysis.
explore_df(${varName})
`;
}

export const CODE_EXECUTION_REQUEST_PROCESSOR =
  new CodeExecutionRequestProcessor();
