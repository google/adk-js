# Artifacts

Artifacts provide persistent storage for files created during agent execution, such as data files, images, plots, and other generated content. The artifact system includes automatic versioning, support for multiple storage backends, and integration with code execution.

## BaseArtifactService Interface

The `BaseArtifactService` interface defines 5 methods for artifact management:

```typescript
export interface BaseArtifactService {
  saveArtifact(request: SaveArtifactRequest): Promise<number>;
  loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined>;
  listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]>;
  deleteArtifact(request: DeleteArtifactRequest): Promise<void>;
  listVersions(request: ListVersionsRequest): Promise<number[]>;
}
```

### saveArtifact()

Saves an artifact identified by appName, userId, sessionId, and filename.

```typescript
saveArtifact(request: SaveArtifactRequest): Promise<number>
```

**Parameters:**

```typescript
interface SaveArtifactRequest {
  appName: string;
  userId: string;
  sessionId: string;
  filename: string;
  artifact: Part;  // From @google/genai
}
```

**Returns:** A revision ID (version number)
- First version has revision ID of 0
- Incremented by 1 after each successful save

**Example:**

```typescript
const version = await artifactService.saveArtifact({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'data.csv',
  artifact: {
    inlineData: {
      mimeType: 'text/csv',
      data: base64EncodedData,
    },
  },
});
// version === 0 (first save)

const version2 = await artifactService.saveArtifact({
  // ... same parameters but updated artifact
  artifact: updatedArtifact,
});
// version2 === 1 (second save)
```

### loadArtifact()

Loads an artifact identified by appName, userId, sessionId, and filename.

```typescript
loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined>
```

**Parameters:**

```typescript
interface LoadArtifactRequest {
  appName: string;
  userId: string;
  sessionId: string;
  filename: string;
  version?: number;  // Optional: load specific version
}
```

**Returns:** The artifact `Part` or `undefined` if not found

**Behavior:**
- If `version` is provided: Loads that specific version
- If `version` is `undefined`: Loads the latest version

**Example:**

```typescript
// Load latest version
const latest = await artifactService.loadArtifact({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'data.csv',
});

// Load specific version
const v0 = await artifactService.loadArtifact({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'data.csv',
  version: 0,
});
```

### listArtifactKeys()

Lists all artifact filenames within a session.

```typescript
listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]>
```

**Parameters:**

```typescript
interface ListArtifactKeysRequest {
  appName: string;
  userId: string;
  sessionId: string;
}
```

**Returns:** A list of all artifact filenames

**Example:**

```typescript
const files = await artifactService.listArtifactKeys({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
});
// Returns: ['data.csv', 'chart.png', 'report.pdf']
```

### deleteArtifact()

Deletes an artifact (all versions).

```typescript
deleteArtifact(request: DeleteArtifactRequest): Promise<void>
```

**Parameters:**

```typescript
interface DeleteArtifactRequest {
  appName: string;
  userId: string;
  sessionId: string;
  filename: string;
}
```

**Returns:** `void` when deletion completes

**Example:**

```typescript
await artifactService.deleteArtifact({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'old_data.csv',
});
```

### listVersions()

Lists all versions of a specific artifact.

```typescript
listVersions(request: ListVersionsRequest): Promise<number[]>
```

**Parameters:**

```typescript
interface ListVersionsRequest {
  appName: string;
  userId: string;
  sessionId: string;
  filename: string;
}
```

**Returns:** A list of all available version numbers for that artifact

**Example:**

```typescript
const versions = await artifactService.listVersions({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'data.csv',
});
// Returns: [0, 1, 2, 3, 4]
```

## Artifact Versioning

ADK-JS provides automatic version control for all saved artifacts:

### Version Numbering

- **First version starts at 0**
- **Each subsequent save increments by 1**
- Versions are returned by `saveArtifact()` as the return value
- Example: First save returns 0, second save returns 1, third returns 2, etc.

### Saving with Versions

Every call to `saveArtifact()` creates a new version:
- Does **NOT** overwrite previous versions
- Returns the new version number (revision ID)
- Allows artifact history to be preserved

```typescript
// Save version 0
const v0 = await artifactService.saveArtifact({
  appName: 'app',
  userId: 'user',
  sessionId: 'session',
  filename: 'data.csv',
  artifact: csvData,
});
// v0 === 0

// Save version 1 (new version, doesn't overwrite v0)
const v1 = await artifactService.saveArtifact({
  appName: 'app',
  userId: 'user',
  sessionId: 'session',
  filename: 'data.csv',
  artifact: updatedCsvData,
});
// v1 === 1

// Both versions exist and can be loaded
```

### Loading with Versions

The `version` parameter in `loadArtifact()` is optional:

```typescript
// Load latest version
const latest = await artifactService.loadArtifact({
  appName: 'app',
  userId: 'user',
  sessionId: 'session',
  filename: 'data.csv',
  // version not provided
});

// Load specific version
const oldVersion = await artifactService.loadArtifact({
  appName: 'app',
  userId: 'user',
  sessionId: 'session',
  filename: 'data.csv',
  version: 0,  // Load first version
});
```

### Use Cases for Versioning

- **Undo/Rollback**: Retrieve previous versions of files
- **Audit Trail**: Track how artifacts evolved over time
- **Comparison**: Compare different versions of the same file
- **Recovery**: Restore accidentally overwritten data

## GcsArtifactService

`GcsArtifactService` implements cloud storage using Google Cloud Storage.

### Initialization

```typescript
import {GcsArtifactService} from '@google/adk';

const artifactService = new GcsArtifactService('my-bucket-name');
```

**Constructor:**
- Takes a bucket name string
- Creates Storage client and gets bucket reference: `this.bucket = new Storage().bucket(bucket)`

### File Path Structure

Artifacts are stored with the following path format:

**Session-scoped artifacts:**
```
{appName}/{userId}/{sessionId}/{filename}/{version}
```

**User-scoped artifacts (with 'user:' prefix):**
```
{appName}/{userId}/user/{filename}/{version}
```

**Example paths:**
```
myapp/user123/session456/data.csv/0     # First version
myapp/user123/session456/data.csv/1     # Second version
myapp/user123/user/user:profile.json/0  # User-scoped artifact
```

### User-Scoped Artifacts

Artifacts with filenames starting with `'user:'` are stored at user level instead of session level:

```typescript
// Session-scoped (default)
await artifactService.saveArtifact({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'data.csv',
  artifact: csvData,
});
// Stored at: myApp/user123/session456/data.csv/0

// User-scoped (accessible across all sessions)
await artifactService.saveArtifact({
  appName: 'myApp',
  userId: 'user123',
  sessionId: 'session456',
  filename: 'user:preferences.json',
  artifact: prefsData,
});
// Stored at: myApp/user123/user/user:preferences.json/0
```

User-scoped artifacts are:
- Accessible across all sessions for that user
- Useful for user preferences, profiles, persistent data
- Detected by `filename.startsWith('user:')`

### Storage Operations

#### saveArtifact

1. Lists existing versions to determine next version number (max + 1, or 0 if none)
2. Saves `inlineData` as JSON string with content type from `mimeType`
3. Saves `text` as plain text with `'text/plain'` content type
4. Throws error if artifact has neither `inlineData` nor `text`

#### loadArtifact

1. If version undefined, lists versions and uses max
2. Downloads file and metadata in parallel
3. Returns `text` Part for `'text/plain'` content type
4. Returns base64 Part for other content types

#### listArtifactKeys

1. Gets files with prefix `{appName}/{userId}/{sessionId}/` for session artifacts
2. Gets files with prefix `{appName}/{userId}/user/` for user artifacts
3. Returns sorted list of filenames (extracts filename from full path)

#### deleteArtifact

1. Lists all versions
2. Deletes all version files in parallel using `Promise.all`

#### listVersions

1. Gets files matching the artifact path prefix
2. Parses version number from end of each file path
3. Returns array of version numbers

### Authentication

GCS requires Google Cloud authentication. The Storage client uses:
- Application Default Credentials (ADC)
- Service account key file
- Environment variable `GOOGLE_APPLICATION_CREDENTIALS`

## InMemoryArtifactService

`InMemoryArtifactService` provides in-memory artifact storage for testing and development.

### Storage Structure

```typescript
export class InMemoryArtifactService implements BaseArtifactService {
  private readonly artifacts: Record<string, Part[]> = {};
}
```

**Storage format:**
- Key: artifact path string
- Value: Array of `Part` objects (one per version)

### Path Construction

```typescript
function artifactPath(
  appName: string,
  userId: string,
  sessionId: string,
  filename: string
): string {
  if (fileHasUserNamespace(filename)) {
    // User-scoped: {appName}/{userId}/user/{filename}
    return `${appName}/${userId}/user/${filename}`;
  }
  // Session-scoped: {appName}/{userId}/{sessionId}/{filename}
  return `${appName}/${userId}/${sessionId}/${filename}`;
}

function fileHasUserNamespace(filename: string): boolean {
  return filename.startsWith('user:');
}
```

### Implementation

#### saveArtifact

```typescript
saveArtifact({appName, userId, sessionId, filename, artifact}: SaveArtifactRequest): Promise<number> {
  const path = artifactPath(appName, userId, sessionId, filename);
  if (!this.artifacts[path]) {
    this.artifacts[path] = [];  // Initialize version array
  }
  const version = this.artifacts[path].length;  // 0-based index
  this.artifacts[path].push(artifact);
  return Promise.resolve(version);
}
```

#### loadArtifact

```typescript
loadArtifact({appName, userId, sessionId, filename, version}: LoadArtifactRequest): Promise<Part | undefined> {
  const path = artifactPath(appName, userId, sessionId, filename);
  const versions = this.artifacts[path];
  if (!versions) return Promise.resolve(undefined);

  if (version === undefined) {
    version = versions.length - 1;  // Latest version
  }
  return Promise.resolve(versions[version]);
}
```

#### listArtifactKeys

```typescript
listArtifactKeys({appName, userId, sessionId}: ListArtifactKeysRequest): Promise<string[]> {
  const sessionPrefix = `${appName}/${userId}/${sessionId}/`;
  const usernamespacePrefix = `${appName}/${userId}/user/`;

  const fileNames: string[] = [];
  for (const path of Object.keys(this.artifacts)) {
    if (path.startsWith(sessionPrefix) || path.startsWith(usernamespacePrefix)) {
      // Extract filename from path
      const filename = path.split('/').pop()!;
      fileNames.push(filename);
    }
  }
  return Promise.resolve(fileNames.sort());
}
```

#### deleteArtifact

```typescript
deleteArtifact({appName, userId, sessionId, filename}: DeleteArtifactRequest): Promise<void> {
  const path = artifactPath(appName, userId, sessionId, filename);
  delete this.artifacts[path];  // Delete entire version array
  return Promise.resolve();
}
```

#### listVersions

```typescript
listVersions({appName, userId, sessionId, filename}: ListVersionsRequest): Promise<number[]> {
  const path = artifactPath(appName, userId, sessionId, filename);
  const versions = this.artifacts[path];
  if (!versions) return Promise.resolve([]);

  // Return [0, 1, 2, ...] for all version indices
  return Promise.resolve(versions.map((_, index) => index));
}
```

### Usage

```typescript
import {InMemoryArtifactService} from '@google/adk';

const artifactService = new InMemoryArtifactService();

const runner = new Runner({
  agent: myAgent,
  sessionService: sessionService,
  artifactService: artifactService,
});
```

## Artifact Service Registry

The artifact service registry provides URI-based service instantiation via `getArtifactServiceFromUri()`.

### Supported URI Schemes

#### 1. 'memory://' - In-memory storage

```typescript
const artifactService = getArtifactServiceFromUri('memory://');
// Returns: new InMemoryArtifactService()
```

**Use cases:**
- Testing
- Development
- Single-process applications

#### 2. 'gs://bucket-name' - Google Cloud Storage

```typescript
const artifactService = getArtifactServiceFromUri('gs://my-app-artifacts');
// Returns: new GcsArtifactService('my-app-artifacts')
```

**Use cases:**
- Production deployments
- Persistent cloud storage
- Multi-instance applications

### Implementation

```typescript
export function getArtifactServiceFromUri(uri: string): BaseArtifactService {
  if (isInMemoryConnectionString(uri)) {
    return new InMemoryArtifactService();
  }

  if (uri.startsWith('gs://')) {
    const bucket = uri.split('://')[1];
    return new GcsArtifactService(bucket);
  }

  throw new Error(`Unsupported artifact service URI: ${uri}`);
}

export function isInMemoryConnectionString(uri: string): boolean {
  return uri === 'memory://';
}
```

### Error Handling

Throws `Error` with message `Unsupported artifact service URI: ${uri}` if URI doesn't match known schemes.

### Usage

```typescript
// From configuration
const artifactServiceUri = process.env.ARTIFACT_SERVICE_URI || 'memory://';
const artifactService = getArtifactServiceFromUri(artifactServiceUri);

const runner = new Runner({
  agent: myAgent,
  sessionService: sessionService,
  artifactService: artifactService,
});
```

## Code Execution Integration

Artifacts integrate with code execution to capture and store output files from code executors.

### Flow Overview

1. Code executor runs code and produces `CodeExecutionResult` with `outputFiles` array
2. `postProcessCodeExecutionResult()` saves these files as artifacts
3. Artifact filenames and versions are tracked in `eventActions.artifactDelta`
4. Event is created with the code execution result and artifact information

### CodeExecutionResult Structure

```typescript
export interface CodeExecutionResult {
  stdout: string;
  stderr: string;
  outputFiles: File[];
}

export interface File {
  name: string;        // Filename with extension
  content: string;     // Base64-encoded bytes
  mimeType: string;    // MIME type (e.g., 'image/png', 'text/csv')
}
```

### Artifact Saving Process

When code execution produces output files:

```typescript
// In postProcessCodeExecutionResult()
if (codeExecutionResult.outputFiles) {
  for (const outputFile of codeExecutionResult.outputFiles) {
    // Save each output file as artifact
    const version = await artifactService.saveArtifact({
      appName: invocationContext.session.appName,
      userId: invocationContext.session.userId,
      sessionId: invocationContext.session.id,
      filename: outputFile.name,
      artifact: {
        inlineData: {
          mimeType: outputFile.mimeType,
          data: outputFile.content,
        },
      },
    });

    // Track in event actions
    eventActions.artifactDelta[outputFile.name] = version;
  }
}
```

### Event Actions Tracking

```typescript
// eventActions.artifactDelta is a Record<string, number>
// Maps filename to version number
eventActions.artifactDelta = {
  'chart.png': 0,
  'result.csv': 2,
  'analysis.json': 1,
};
```

This delta gets persisted with the event, allowing tracking of which artifacts were created/updated during code execution.

### Result Formatting

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

### Example Flow

```typescript
// Code executor returns:
{
  stdout: "Processing complete",
  stderr: "",
  outputFiles: [
    {name: "result.csv", content: "base64data...", mimeType: "text/csv"},
    {name: "chart.png", content: "base64data...", mimeType: "image/png"}
  ]
}

// Artifacts are saved:
// - result.csv (version 0)
// - chart.png (version 0)

// Event includes:
{
  actions: {
    artifactDelta: {
      "result.csv": 0,
      "chart.png": 0
    }
  },
  content: {
    parts: [{
      text: "Code execution result:\nProcessing complete\n\nSaved artifacts:\nresult.csv, chart.png",
      codeExecutionResult: {outcome: "OUTCOME_OK"}
    }]
  }
}
```

## ForwardingArtifactService

`ForwardingArtifactService` enables artifact operations from sub-agents to forward to their parent agent's `ToolContext`.

### Purpose

Used in `AgentTool` to allow a sub-agent (running inside an AgentTool) to access the parent agent's artifact service through its `ToolContext`. This enables artifact sharing between parent and child agents.

### Architecture

```typescript
export class ForwardingArtifactService implements BaseArtifactService {
  private readonly invocationContext: InvocationContext;

  constructor(private readonly toolContext: ToolContext) {
    this.invocationContext = toolContext.invocationContext;
  }
}
```

**Components:**
- Implements `BaseArtifactService` interface
- Wraps a `ToolContext` from the parent agent
- Stores both the `ToolContext` and its `InvocationContext`

### Method Forwarding

#### saveArtifact()

```typescript
async saveArtifact(request: SaveArtifactRequest): Promise<number> {
  // Ignores request parameters (appName, userId, sessionId)
  // Forwards to toolContext.saveArtifact(filename, artifact)
  return this.toolContext.saveArtifact(request.filename, request.artifact);
}
```

#### loadArtifact()

```typescript
async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
  // Ignores request parameters except filename and version
  return this.toolContext.loadArtifact(request.filename, request.version);
}
```

#### listArtifactKeys()

```typescript
async listArtifactKeys(): Promise<string[]> {
  // Ignores all request parameters
  return this.toolContext.listArtifacts();
}
```

#### deleteArtifact()

```typescript
async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
  if (!this.invocationContext.artifactService) {
    throw new Error('Artifact service is not initialized.');
  }
  // Forwards directly to invocationContext.artifactService
  return this.invocationContext.artifactService.deleteArtifact(request);
}
```

#### listVersions()

```typescript
async listVersions(request: ListVersionsRequest): Promise<number[]> {
  if (!this.invocationContext.artifactService) {
    throw new Error('Artifact service is not initialized.');
  }
  // Forwards directly to invocationContext.artifactService
  return this.invocationContext.artifactService.listVersions(request);
}
```

### Usage in AgentTool

When `AgentTool` creates a `Runner` for the sub-agent, it provides `ForwardingArtifactService` as the artifact service:

```typescript
// In AgentTool
const forwardingArtifactService = new ForwardingArtifactService(toolContext);

const subAgentRunner = new Runner({
  agent: subAgent,
  artifactService: forwardingArtifactService,
  // ...
});
```

This ensures the sub-agent's artifact operations are visible to the parent agent and stored in the parent's session context.

## Complete Example

```typescript
import {
  Runner,
  InMemoryRunner,
  GcsArtifactService,
  LlmAgent,
  FunctionTool,
} from '@google/adk';

// Setup artifact service
const artifactService = new GcsArtifactService('my-app-artifacts');

// Create a tool that saves artifacts
const saveDataTool = new FunctionTool({
  name: 'save_data',
  description: 'Save data to artifact storage',
  parameters: z.object({
    filename: z.string(),
    data: z.string(),
  }),
  execute: async (args, context) => {
    const version = await context.saveArtifact(args.filename, {
      text: args.data,
    });
    return {
      message: `Saved ${args.filename} (version ${version})`,
    };
  },
});

// Create a tool that loads artifacts
const loadDataTool = new FunctionTool({
  name: 'load_data',
  description: 'Load data from artifact storage',
  parameters: z.object({
    filename: z.string(),
    version: z.number().optional(),
  }),
  execute: async (args, context) => {
    const artifact = await context.loadArtifact(args.filename, args.version);
    if (!artifact) {
      return {error: `Artifact ${args.filename} not found`};
    }
    return {
      filename: args.filename,
      data: artifact.text || '[binary data]',
    };
  },
});

// Create agent with tools
const agent = new LlmAgent({
  name: 'data_agent',
  model: 'gemini-2.0-flash-exp',
  tools: [saveDataTool, loadDataTool],
});

// Create runner with GCS artifact service
const runner = new Runner({
  appName: 'myApp',
  agent: agent,
  sessionService: getSessionServiceFromUri('memory://'),
  artifactService: artifactService,
});

// Run the agent
for await (const event of runner.runAsync({
  userId: 'user123',
  sessionId: 'session456',
  newMessage: {
    role: 'user',
    parts: [{text: 'Save "Hello, World!" to greeting.txt'}],
  },
})) {
  console.log(event);
}
```

## See Also

- [Code Execution](./code-execution.md) - Code execution and output file handling
- [Tools](./tools.md) - Tool context artifact methods
- [Sessions](./sessions.md) - Session management and state
