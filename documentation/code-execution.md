# Code Execution

The code execution system allows agents to execute code blocks from model responses and incorporate execution results into the conversation. ADK-JS supports both Gemini's built-in code execution and custom code executors.

## BaseCodeExecutor Configuration

The `BaseCodeExecutor` abstract class defines the contract for code execution with configurable properties.

```typescript
export abstract class BaseCodeExecutor {
  optimizeDataFile = false;
  stateful = false;
  errorRetryAttempts = 2;
  codeBlockDelimiters: Array<[string, string]> = [
    ['```tool_code\n', '\n```'],
    ['```python\n', '\n```'],
  ];
  executionResultDelimiters: [string, string] = ['```tool_output\n', '\n```'];

  abstract executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult>;
}
```

### Properties

#### optimizeDataFile

```typescript
optimizeDataFile = false;
```

If `true`, extract and process data files from the model request and attach them to the code executor.

**Supported data file MIME types:**
- `text/csv`

**When enabled:**
- Extracts inline data from model requests
- Creates file objects for code to access
- Pre-processes data files (e.g., runs exploratory code on CSV files)
- Attaches files to code executor context

**Default:** `false`

#### stateful

```typescript
stateful = false;
```

Whether the code executor maintains state across executions.

**When `true`:**
- Execution ID tied to session ID
- Variables persist between code runs
- Single execution environment per session
- Enables multi-turn data analysis

**When `false`:**
- Fresh environment for each execution
- No state preservation
- Isolated executions

**Default:** `false`

See [Stateful Execution](#stateful-code-execution) section for details.

#### errorRetryAttempts

```typescript
errorRetryAttempts = 2;
```

Number of consecutive code execution errors before stopping retry.

**Purpose:**
- Prevents infinite error loops
- Allows model to see errors and retry with corrected code
- Stops after N consecutive failures

**Flow:**
1. Code executes and fails (stderr not empty)
2. Error count increments
3. Model sees error and generates new code
4. If error count < errorRetryAttempts, new code executes
5. If error count >= errorRetryAttempts, execution stops

**Default:** `2` attempts

#### codeBlockDelimiters

```typescript
codeBlockDelimiters: Array<[string, string]> = [
  ['```tool_code\n', '\n```'],
  ['```python\n', '\n```'],
];
```

List of enclosing delimiter pairs to identify code blocks.

**Format:**
- Array of `[opening delimiter, closing delimiter]` tuples
- Matched in order (first match wins)

**Example code block formats:**

````markdown
```tool_code
print("hello")
```

```python
print("hello")
```
````

**Custom delimiters:**

```typescript
const executor = new MyCodeExecutor();
executor.codeBlockDelimiters = [
  ['```javascript\n', '\n```'],
  ['```js\n', '\n```'],
];
```

#### executionResultDelimiters

```typescript
executionResultDelimiters: [string, string] = ['```tool_output\n', '\n```'];
```

Delimiters to format code execution result output.

**Format:**
- Single pair of `[opening, closing]`

**Example result format:**

````markdown
```tool_output
Code execution result:
Hello, World!
```
````

### Abstract Method: executeCode()

```typescript
abstract executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult>
```

Executes code and returns the code execution result.

**Parameters:**

```typescript
export interface ExecuteCodeParams {
  invocationContext: InvocationContext;
  codeExecutionInput: CodeExecutionInput;
}
```

**Returns:** `Promise<CodeExecutionResult>`

## BuiltInCodeExecutor

`BuiltInCodeExecutor` integrates with Gemini's native code execution capability rather than executing code locally.

### Key Characteristics

**Gemini-Native Integration:**
- Uses Gemini 2.0+ model's built-in code execution feature
- Code execution happens server-side on Gemini API
- Adds `{codeExecution: {}}` to model's tools config

**Model Version Check:**
- Validates model is Gemini 2.0 or above
- Uses `isGemini2OrAbove(llmRequest.model)` helper
- Throws error if model doesn't support built-in code execution

**No Actual Execution:**
- `executeCode()` returns empty result immediately
- Does not actually run code - handled by Gemini API

### Implementation

```typescript
export class BuiltInCodeExecutor extends BaseCodeExecutor {
  executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      outputFiles: [],
    });
  }

  processLlmRequest(llmRequest: LlmRequest) {
    if (llmRequest.model && isGemini2OrAbove(llmRequest.model)) {
      llmRequest.config = llmRequest.config || {};
      llmRequest.config.tools = llmRequest.config.tools || [];
      llmRequest.config.tools.push({codeExecution: {}});
      return;
    }

    throw new Error(
      `Gemini code execution tool is not supported for model ${llmRequest.model}`,
    );
  }
}
```

### Usage

```typescript
import {LlmAgent, BuiltInCodeExecutor} from '@google/adk';

const agent = new LlmAgent({
  name: 'code_agent',
  model: 'gemini-2.0-flash-exp',
  codeExecutor: new BuiltInCodeExecutor(),
});
```

### Comparison: BuiltInCodeExecutor vs Custom Code Executors

| Aspect | BuiltInCodeExecutor | Custom Code Executors |
|--------|--------------------|-----------------------|
| Code execution | Server-side on Gemini API | Client-side in custom environment |
| executeCode() | Returns empty result | Actually executes code |
| Configuration | Adds tool to LLM config | Manages own execution environment |
| Model support | Gemini 2.0+ only | Model-agnostic |
| State management | Handled by Gemini | Controlled by `stateful` property |
| Security | Sandboxed by Google | Developer responsible |
| File handling | Managed by Gemini | Custom implementation |
| Network access | Available (Gemini side) | Depends on implementation |

## Request and Response Processors

Code execution integrates with the LLM agent pipeline through request and response processors.

### CodeExecutionRequestProcessor

Pre-processes LLM requests when code execution is enabled.

#### Main Processing Flow

```typescript
class CodeExecutionRequestProcessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    if (!isLlmAgent(invocationContext.agent)) return;
    if (!invocationContext.agent.codeExecutor) return;

    // Run pre-processor for data file optimization
    for await (const event of runPreProcessor(invocationContext, llmRequest)) {
      yield event;
    }

    // Convert code execution parts to text format
    if (!isBaseCodeExecutor(invocationContext.agent.codeExecutor)) return;

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
```

#### Data File Optimization

When `optimizeDataFile = true`:

1. **Skip Conditions:**
   - If codeExecutor is `BuiltInCodeExecutor` (handles execution itself)
   - If `optimizeDataFile` is `false`
   - If error count >= `errorRetryAttempts`

2. **Extract and Replace Inline Files:**
   - Scans all Parts in `llmRequest.contents` for `inlineData`
   - For supported MIME types (text/csv), extracts data to `File` objects
   - Replaces `inlineData` Parts with `text` Parts referencing filename
   - Returns array of all extracted `File` objects

3. **Data File Pre-Exploration:**
   - Filters to unprocessed files (not in `codeExecutorContext.processedFileNames`)
   - For each new data file:
     - Generates pre-processing code via `getDataFilePreprocessingCode(file)`
     - Creates model event with executable code Part
     - Executes the pre-processing code
     - Saves execution result to `codeExecutorContext`
     - Marks file as processed
     - Yields both code event and result event
     - Adds both events to `llmRequest.contents`

**Example CSV Pre-Exploration Code:**

```python
import pandas as pd

def explore_df(df: pd.DataFrame) -> None:
    print("Column names:", df.columns.tolist())
    print("\nData types:")
    print(df.dtypes)
    print("\nNull counts:")
    print(df.isnull().sum())
    print("\nUnique value counts:")
    for col in df.columns:
        print(f"{col}: {df[col].nunique()}")
    print("\nUnique values:")
    for col in df.columns:
        print(f"{col}: {df[col].unique()[:10]}")

df = pd.read_csv('data.csv')
explore_df(df)
```

#### Inline Data Replacement

Replaces binary data inline with text reference:

**Before:**
```typescript
{
  inlineData: {
    mimeType: 'text/csv',
    data: 'base64encodeddata...'
  }
}
```

**After:**
```typescript
{
  text: 'Attached file: data.csv'
}
```

Actual data stored in `CodeExecutorContext.inputFiles`.

### CodeExecutionResponseProcessor

Post-processes model responses by extracting and executing code blocks.

#### Main Flow

```typescript
class CodeExecutionResponseProcessor implements BaseLlmResponseProcessor {
  async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, unknown> {
    if (llmResponse.partial) return;  // Skip streaming chunks

    for await (const event of runPostProcessor(invocationContext, llmResponse)) {
      yield event;
    }
  }
}
```

#### Post-Processing Steps

1. **Validation and Setup:**
   - Validates agent is `LlmAgent` with `codeExecutor`
   - Skips if `codeExecutor` is `BuiltInCodeExecutor`
   - Creates `CodeExecutorContext` from session state
   - Checks error count < `errorRetryAttempts`

2. **Code Extraction:**
   - Calls `extractCodeAndTruncateContent(responseContent, codeBlockDelimiters)`
   - Searches for first code block matching any delimiter pattern
   - Extracts code string from the block
   - Truncates content to only include parts up to the code block
   - Converts text to `executableCode` Part
   - Returns empty string if no code found (terminal state)

3. **Code Execution:**
   - Yields event with the extracted code (model's response)
   - Gets or creates execution ID for stateful executors
   - Calls `codeExecutor.executeCode()` with code and input files
   - Gets `CodeExecutionResult`: `{stdout, stderr, outputFiles}`

4. **Result Tracking:**
   - Updates `codeExecutorContext` with execution metadata
   - Stores per invocation for debugging/history

5. **Result Processing:**
   - Calls `postProcessCodeExecutionResult()`
   - Saves output files as artifacts
   - Tracks artifact versions in `eventActions.artifactDelta`
   - Creates event with code execution result Part
   - Yields the execution result event

6. **Error Handling and Retry:**
   - If `stderr` is not empty, increments error count
   - If error count < `errorRetryAttempts`, continues processing
   - Model sees `stderr` and can retry with corrected code
   - If error count >= `errorRetryAttempts`, stops processing
   - On successful execution (no `stderr`), resets error count

7. **Response Mutation:**
   - Sets `llmResponse.content = undefined`
   - Signals agent loop to continue generating
   - Prevents original model response from being returned
   - Allows model to see execution result and generate more code or final response

#### Code Extraction Example

**Input:**
````
I'll analyze the data:
```python
import pandas as pd
df.head()
```
Let me show you the first rows.
````

**Extracted code:**
```python
import pandas as pd
df.head()
```

**Truncated content:** Parts up to the code block only

## CodeExecutorContext

`CodeExecutorContext` manages code execution state across invocations using session state.

### Storage Structure

Wraps session `State` object and uses multiple keys:
- `'_code_execution_context'` - Main context object
- `'_code_executor_input_files'` - Array of input files
- `'_code_executor_error_counts'` - Error counts per invocation
- `'_code_execution_results'` - Execution history per invocation

### Main Context Object

Stored at `'_code_execution_context'` with fields:

```typescript
{
  'execution_session_id': string;      // Execution ID for stateful executors
  'processed_input_files': string[];   // Array of processed file names
}
```

### Key Methods

#### Execution ID Management

```typescript
getExecutionId(): string | undefined {
  return this.context['execution_session_id'];
}

setExecutionId(executionId: string) {
  this.context['execution_session_id'] = executionId;
}
```

Used when `codeExecutor.stateful = true`:
- Ties execution environment to session ID
- Allows code state to persist across agent invocations

#### Processed File Tracking

```typescript
getProcessedFileNames(): string[] {
  return this.context['processed_input_files'] || [];
}

addProcessedFileNames(fileNames: string[]) {
  if (!this.context['processed_input_files']) {
    this.context['processed_input_files'] = [];
  }
  this.context['processed_input_files'].push(...fileNames);
}
```

Tracks which data files have been pre-processed to prevent re-processing.

#### Input File Management

```typescript
getInputFiles(): File[] {
  return this.sessionState.get('_code_executor_input_files') as File[] || [];
}

addInputFiles(inputFiles: File[]) {
  const currentFiles = this.getInputFiles();
  currentFiles.push(...inputFiles);
  this.sessionState.set('_code_executor_input_files', currentFiles);
}

clearInputFiles() {
  this.sessionState.set('_code_executor_input_files', []);
  this.context['processed_input_files'] = [];
}
```

Stores extracted data files from inline data, available to all code executions in session.

#### Error Count Tracking

```typescript
getErrorCount(invocationId: string): number {
  const counts = this.sessionState.get('_code_executor_error_counts') as Record<string, number>;
  return counts?.[invocationId] || 0;
}

incrementErrorCount(invocationId: string) {
  const counts = this.sessionState.get('_code_executor_error_counts') as Record<string, number> || {};
  counts[invocationId] = (counts[invocationId] || 0) + 1;
  this.sessionState.set('_code_executor_error_counts', counts);
}

resetErrorCount(invocationId: string) {
  const counts = this.sessionState.get('_code_executor_error_counts') as Record<string, number>;
  if (counts) {
    delete counts[invocationId];
  }
}
```

Tracks consecutive errors per invocation ID to enforce `errorRetryAttempts` limit.

#### Execution History

```typescript
updateCodeExecutionResult({invocationId, code, resultStdout, resultStderr}) {
  // Stores execution metadata:
  // - code executed
  // - stdout/stderr
  // - timestamp
  // Organized by invocationId
}
```

Maintains history of all executions for debugging and analysis.

#### State Delta

```typescript
getStateDelta(): Record<string, unknown> {
  return {'_code_execution_context': cloneDeep(this.context)};
}
```

Returns changes to persist to session, called after code execution completes.

## Stateful Code Execution

Stateful execution maintains code execution state across multiple agent invocations when `BaseCodeExecutor.stateful = true`.

### Execution ID Mechanism

#### Execution ID Tied to Session

When `stateful=true`:
- Execution ID is tied to session ID
- Single execution environment persists for entire session
- Variables, imports, and state maintained across code runs

#### Execution ID Management

```typescript
function getOrSetExecutionId(
  invocationContext: InvocationContext,
  codeExecutorContext: CodeExecutorContext,
): string | undefined {
  const codeExecutor = invocationContext.agent.codeExecutor;

  if (!codeExecutor.stateful) {
    return undefined;  // No execution ID for stateless
  }

  let executionId = codeExecutorContext.getExecutionId();
  if (!executionId) {
    executionId = invocationContext.session.id;  // Use session ID
    codeExecutorContext.setExecutionId(executionId);
  }
  return executionId;
}
```

#### Storage

- Execution ID stored in session state at `'_code_execution_context'`
- Field name: `'execution_session_id'`
- Retrieved on subsequent invocations
- Persists across agent runs within same session

### Stateless vs Stateful Execution

#### Stateless (stateful=false)

```typescript
// First invocation
executeCode({executionId: undefined, code: 'x = 5', inputFiles: []})
// Variables not preserved

// Second invocation
executeCode({executionId: undefined, code: 'print(x)', inputFiles: []})
// Fresh environment, x unavailable -> Error
```

#### Stateful (stateful=true)

```typescript
// First invocation
executeCode({executionId: 'session-123', code: 'x = 5', inputFiles: []})
// Variables stored in environment 'session-123'

// Second invocation
executeCode({executionId: 'session-123', code: 'print(x)', inputFiles: []})
// Same environment, x available -> Prints: 5
```

### Example Use Case

```python
# First code execution (invocation 1)
import pandas as pd
df = pd.read_csv('data.csv')
print(df.head())

# Second code execution (invocation 2)
# With stateful=true: df is still available!
print(df.describe())

# With stateful=false: df not available, would error
```

### Benefits

- Enables multi-turn data analysis
- Variables persist between agent responses
- No need to reload data or re-run setup code
- Natural conversation flow for exploratory work

### Implementation Requirements

Custom code executors must:
- Accept `executionId` in `CodeExecutionInput`
- Maintain separate execution environments per ID
- Return same environment when given same ID
- Clean up environments when sessions end (optional)

### Lifecycle

1. User starts session, gets session ID
2. First code execution creates environment with `executionId=sessionId`
3. Subsequent code executions reuse same environment
4. Session ends, environment can be cleaned up

## Input and Output Structures

### CodeExecutionInput

Represents the input to code execution.

```typescript
export interface CodeExecutionInput {
  code: string;           // The code to execute
  inputFiles: File[];     // Input files available to the code
  executionId?: string;   // Execution ID for stateful code execution
}
```

**Fields:**
- **code**: The actual Python (or other language) code to execute
- **inputFiles**: Files extracted from inline data or uploaded by user, available to code as named files
- **executionId**: Optional identifier for stateful execution environment (uses session ID when `stateful=true`)

### CodeExecutionResult

Represents the output from code execution.

```typescript
export interface CodeExecutionResult {
  stdout: string;        // Standard output of code execution
  stderr: string;        // Standard error of code execution
  outputFiles: File[];   // Output files from code execution
}
```

**Fields:**
- **stdout**: Standard output stream from code execution, typically contains print statements and results
- **stderr**: Standard error stream, contains error messages and stack traces (empty string if no errors)
- **outputFiles**: Files created by the code (e.g., plots, CSVs, data files) that should be saved as artifacts

### File Structure

Used for both input and output files.

```typescript
export interface File {
  name: string;      // Filename with extension (e.g., 'file.csv')
  content: string;   // Base64-encoded bytes of file content
  mimeType: string;  // MIME type (e.g., 'image/png', 'text/csv')
}
```

**Fields:**
- **name**: Filename used to reference the file in code (e.g., in `pd.read_csv('data.csv')`)
- **content**: File content as base64-encoded string (use `getEncodedFileContent()` helper)
- **mimeType**: Content type for proper handling (text/csv, image/png, application/json, etc.)

### Usage Example

```typescript
// Input
const input: CodeExecutionInput = {
  code: `
import pandas as pd
df = pd.read_csv('data.csv')
print(df.head())
  `,
  inputFiles: [
    {
      name: 'data.csv',
      content: base64EncodedCsvData,
      mimeType: 'text/csv'
    }
  ],
  executionId: 'session-123'
};

// Output
const result: CodeExecutionResult = {
  stdout: "   name  age\n0  Alice   25\n1  Bob     30",
  stderr: "",
  outputFiles: [
    {
      name: 'chart.png',
      content: base64EncodedImageData,
      mimeType: 'image/png'
    }
  ]
};
```

### Helper Functions

#### getEncodedFileContent()

Ensures content is base64-encoded.

```typescript
export function getEncodedFileContent(data: string): string {
  return isBase64Encoded(data) ? data : base64Encode(data);
}
```

#### buildExecutableCodePart()

Creates a Part with `executableCode` field.

```typescript
export function buildExecutableCodePart(code: string): Part {
  return {
    text: code,
    executableCode: {
      code,
      language: Language.PYTHON,
    },
  };
}
```

#### buildCodeExecutionResultPart()

Creates Part with `codeExecutionResult` field.

```typescript
export function buildCodeExecutionResultPart(
  codeExecutionResult: CodeExecutionResult,
): Part {
  if (codeExecutionResult.stderr) {
    return {
      text: codeExecutionResult.stderr,
      codeExecutionResult: {outcome: Outcome.OUTCOME_FAILED},
    };
  }

  const finalResult = [];
  if (codeExecutionResult.stdout || !codeExecutionResult.outputFiles) {
    finalResult.push(`Code execution result:\n${codeExecutionResult.stdout}\n`);
  }
  if (codeExecutionResult.outputFiles) {
    finalResult.push(
      `Saved artifacts:\n` +
        codeExecutionResult.outputFiles.map((f) => f.name).join(', '),
    );
  }

  return {
    text: finalResult.join('\n\n'),
    codeExecutionResult: {outcome: Outcome.OUTCOME_OK},
  };
}
```

## Complete Custom Code Executor Example

```typescript
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
  CodeExecutionResult,
  File,
} from '@google/adk';
import {spawn} from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export class PythonCodeExecutor extends BaseCodeExecutor {
  private workspaces = new Map<string, string>();  // executionId -> workspace path

  constructor() {
    super();
    this.stateful = true;
    this.errorRetryAttempts = 3;
    this.optimizeDataFile = true;
  }

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    const {codeExecutionInput} = params;
    const {code, inputFiles, executionId} = codeExecutionInput;

    // Get or create workspace
    const workspace = await this.getWorkspace(executionId);

    // Write input files
    for (const file of inputFiles) {
      const filePath = path.join(workspace, file.name);
      const content = Buffer.from(file.content, 'base64');
      await fs.writeFile(filePath, content);
    }

    // Write code to file
    const codeFile = path.join(workspace, 'code.py');
    await fs.writeFile(codeFile, code);

    // Execute code
    const {stdout, stderr} = await this.runPython(codeFile, workspace);

    // Find output files
    const outputFiles = await this.findOutputFiles(workspace, inputFiles);

    return {stdout, stderr, outputFiles};
  }

  private async getWorkspace(executionId?: string): Promise<string> {
    if (!executionId) {
      // Stateless: create temp workspace
      const workspace = path.join('/tmp', `workspace-${Date.now()}`);
      await fs.mkdir(workspace, {recursive: true});
      return workspace;
    }

    // Stateful: reuse workspace
    if (!this.workspaces.has(executionId)) {
      const workspace = path.join('/tmp', `workspace-${executionId}`);
      await fs.mkdir(workspace, {recursive: true});
      this.workspaces.set(executionId, workspace);
    }

    return this.workspaces.get(executionId)!;
  }

  private async runPython(
    codeFile: string,
    cwd: string,
  ): Promise<{stdout: string; stderr: string}> {
    return new Promise((resolve) => {
      const process = spawn('python3', [codeFile], {cwd});

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', () => {
        resolve({stdout, stderr});
      });
    });
  }

  private async findOutputFiles(
    workspace: string,
    inputFiles: File[],
  ): Promise<File[]> {
    const inputNames = new Set(inputFiles.map((f) => f.name));
    inputNames.add('code.py');  // Exclude code file

    const files = await fs.readdir(workspace);
    const outputFiles: File[] = [];

    for (const filename of files) {
      if (inputNames.has(filename)) continue;

      const filePath = path.join(workspace, filename);
      const stat = await fs.stat(filePath);

      if (stat.isFile()) {
        const content = await fs.readFile(filePath);
        const base64 = content.toString('base64');

        // Detect MIME type
        let mimeType = 'application/octet-stream';
        if (filename.endsWith('.csv')) mimeType = 'text/csv';
        if (filename.endsWith('.json')) mimeType = 'application/json';
        if (filename.endsWith('.png')) mimeType = 'image/png';
        if (filename.endsWith('.jpg') || filename.endsWith('.jpeg'))
          mimeType = 'image/jpeg';

        outputFiles.push({
          name: filename,
          content: base64,
          mimeType,
        });
      }
    }

    return outputFiles;
  }
}

// Usage
const agent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.0-flash-exp',
  codeExecutor: new PythonCodeExecutor(),
});
```

## Best Practices

1. **Use BuiltInCodeExecutor for Gemini 2.0+**: Simplest option with Google-managed sandbox
2. **Enable stateful for data analysis**: Allows multi-turn exploration without reloading data
3. **Set appropriate errorRetryAttempts**: Balance between giving model chances to correct vs preventing infinite loops
4. **Validate code before execution**: For custom executors, consider basic security checks
5. **Sandbox custom executors**: Use containers, VMs, or restricted environments
6. **Clean up resources**: Remove temporary workspaces and files after sessions end
7. **Handle output files**: Save important outputs as artifacts for persistence
8. **Monitor execution time**: Set timeouts to prevent hanging executions
9. **Log execution history**: Keep track of code runs for debugging and auditing

## See Also

- [Artifacts](./artifacts.md) - Artifact storage for output files
- [Agents](./agents.md) - LlmAgent configuration
- [Sessions](./sessions.md) - Session state management
