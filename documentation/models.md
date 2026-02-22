# Models

Models in ADK-JS represent Language Model (LLM) integrations. The framework provides a flexible abstraction layer that allows multiple LLM providers while maintaining a consistent interface.

## Table of Contents

- [BaseLlm Contract](#basellm-contract)
- [Gemini Implementation](#gemini-implementation)
- [LLMRegistry](#llmregistry)
- [ApigeeLlm](#apigeellm)
- [LlmRequest and LlmResponse](#llmrequest-and-llmresponse)
- [Custom LLM Registration](#custom-llm-registration)
- [GoogleLLMVariant](#googlellmvariant)

## BaseLlm Contract

`BaseLlm` is the abstract base class that all LLM implementations must extend.

### Interface

```typescript
abstract class BaseLlm {
  readonly model: string;

  constructor({model}: {model: string});

  static readonly supportedModels: Array<string | RegExp> = [];

  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean
  ): AsyncGenerator<LlmResponse, void>;

  abstract connect(llmRequest: LlmRequest): Promise<BaseLlmConnection>;

  maybeAppendUserContent(llmRequest: LlmRequest): void;
}
```

### Core Methods

#### `generateContentAsync(llmRequest, stream?)`

Primary method for generating content from the model. Returns an `AsyncGenerator` that yields `LlmResponse` objects.

**Parameters:**
- `llmRequest: LlmRequest` - The request containing contents, tools, and configuration
- `stream?: boolean` - Whether to stream responses (default: `false`)

**Behavior:**
- When `stream=true`: Yields multiple partial responses as they arrive
- When `stream=false`: Yields a single complete response

```typescript
// Non-streaming
for await (const response of llm.generateContentAsync(request, false)) {
  console.log(response.content); // Single complete response
}

// Streaming
for await (const response of llm.generateContentAsync(request, true)) {
  if (response.partial) {
    console.log('Partial:', response.content);
  } else {
    console.log('Complete:', response.content);
  }
}
```

#### `connect(llmRequest)`

Creates a bidirectional live connection to the LLM for real-time interaction.

```typescript
const connection = await llm.connect(llmRequest);
// Use connection for bidirectional streaming
```

#### `maybeAppendUserContent(llmRequest)`

Ensures the model can continue generating by appending user messages if needed:

- If `contents` is empty: Adds generic user message
- If last message is not from user: Appends continuation prompt

```typescript
maybeAppendUserContent(llmRequest: LlmRequest): void {
  if (llmRequest.contents.length === 0) {
    llmRequest.contents.push({
      role: 'user',
      parts: [{
        text: 'Handle the requests as specified in the System Instruction.'
      }]
    });
  }

  if (llmRequest.contents[llmRequest.contents.length - 1]?.role !== 'user') {
    llmRequest.contents.push({
      role: 'user',
      parts: [{
        text: 'Continue processing previous requests as instructed.'
      }]
    });
  }
}
```

### Static Properties

#### `supportedModels`

Array of string literals or RegExp patterns that this LLM class supports:

```typescript
static readonly supportedModels: Array<string | RegExp> = [
  /gemini-.*/,
  /custom-model-.*/,
  'specific-model-name'
];
```

The `LLMRegistry` uses these patterns to route model names to appropriate implementations.

### Type Guard

```typescript
import { isBaseLlm } from '@google/adk';

if (isBaseLlm(obj)) {
  // obj is BaseLlm instance
}
```

## Gemini Implementation

The `Gemini` class implements Google's Gemini models with support for both API Key and Vertex AI authentication.

### Constructor Parameters

```typescript
interface GeminiParams {
  model?: string;           // Defaults to 'gemini-2.5-flash'
  apiKey?: string;          // API key for Gemini API mode
  vertexai?: boolean;       // Use Vertex AI (requires project/location)
  project?: string;         // Vertex AI project ID
  location?: string;        // Vertex AI region (e.g., 'us-central1')
  headers?: Record<string, string>; // Custom headers
}
```

### API Key Mode

Uses Google AI Studio API with API key authentication:

```typescript
import { Gemini } from '@google/adk';

// Explicit API key
const llm = new Gemini({
  model: 'gemini-2.5-flash',
  apiKey: 'YOUR_API_KEY'
});

// From environment variable (GOOGLE_GENAI_API_KEY or GEMINI_API_KEY)
const llm = new Gemini({
  model: 'gemini-2.5-flash'
});
```

**Environment Variables:**
- `GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY` - API key
- `GOOGLE_GENAI_USE_VERTEXAI` - Set to `'true'` or `'1'` to enable Vertex AI mode

### Vertex AI Mode

Uses Application Default Credentials (ADC) for authentication:

```typescript
const llm = new Gemini({
  model: 'gemini-2.5-flash',
  vertexai: true,
  project: 'my-gcp-project',
  location: 'us-central1'
});

// Or via environment
// GOOGLE_GENAI_USE_VERTEXAI=true
// GOOGLE_CLOUD_PROJECT=my-gcp-project
// GOOGLE_CLOUD_LOCATION=us-central1
const llm = new Gemini({
  model: 'gemini-2.5-flash'
});
```

**Required Environment Variables for Vertex AI:**
- `GOOGLE_GENAI_USE_VERTEXAI='true'`
- `GOOGLE_CLOUD_PROJECT` - GCP project ID
- `GOOGLE_CLOUD_LOCATION` - GCP region

**Authentication:**
- Uses Application Default Credentials
- Supports service accounts, user credentials, or Compute Engine default service account

### Supported Model Patterns

```typescript
static readonly supportedModels = [
  /gemini-.*/,                                              // All Gemini models
  /projects\/.+\/locations\/.+\/endpoints\/.+/,           // Fine-tuned endpoints
  /projects\/.+\/locations\/.+\/publishers\/google\/models\/gemini.+/ // Long names
];
```

**Examples:**
- `gemini-2.5-flash`
- `gemini-2.5-pro`
- `gemini-1.5-flash-001`
- `projects/my-project/locations/us-central1/endpoints/my-tuned-model`

### Streaming Implementation

The Gemini implementation includes advanced streaming with thought accumulation:

```typescript
override async *generateContentAsync(
  llmRequest: LlmRequest,
  stream = false
): AsyncGenerator<LlmResponse, void> {
  this.preprocessRequest(llmRequest);
  this.maybeAppendUserContent(llmRequest);

  if (stream) {
    const streamResult = await this.apiClient.models.generateContentStream({
      model: llmRequest.model ?? this.model,
      contents: llmRequest.contents,
      config: llmRequest.config
    });

    let thoughtText = '';
    let text = '';

    for await (const response of streamResult) {
      const llmResponse = createLlmResponse(response);
      const firstPart = llmResponse.content?.parts?.[0];

      // Accumulate thought and regular text separately
      if (firstPart?.text) {
        if ('thought' in firstPart && firstPart.thought) {
          thoughtText += firstPart.text;
        } else {
          text += firstPart.text;
        }
        llmResponse.partial = true;
      }

      yield llmResponse;
    }
  } else {
    // Non-streaming
    const response = await this.apiClient.models.generateContent({...});
    yield createLlmResponse(response);
  }
}
```

### Thought Accumulation

Gemini models can return "thoughts" (reasoning traces) separately from regular content. The streaming implementation:

1. Separates thought text (marked with `thought: true`) from regular text
2. Accumulates both separately
3. Flushes accumulated text when content type changes
4. Returns final accumulated content on `STOP` finish reason

### Request Preprocessing

The `preprocessRequest()` method adapts requests based on the backend:

```typescript
protected preprocessRequest(llmRequest: LlmRequest): void {
  if (this.apiBackend === GoogleLLMVariant.GEMINI_API) {
    // Google AI Studio doesn't support labels
    if (llmRequest.config?.labels) {
      delete llmRequest.config.labels;
    }

    // Remove displayName from Blob/FileData (Vertex AI specific)
    removeDisplayNameFromContents(llmRequest.contents);
  }
  // VERTEX_AI mode preserves all fields
}
```

### Live Connection Support

```typescript
override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
  // Configure tracking headers
  if (llmRequest.liveConnectConfig?.httpOptions) {
    Object.assign(
      llmRequest.liveConnectConfig.httpOptions.headers,
      this.trackingHeaders
    );
    llmRequest.liveConnectConfig.httpOptions.apiVersion = this.liveApiVersion;
  }

  // Create live connection
  const connection = await this.liveApiClient.models.live.connect({
    model: llmRequest.model ?? this.model,
    config: llmRequest.liveConnectConfig
  });

  return new GeminiLlmConnection(connection);
}
```

## LLMRegistry

Factory/registry pattern for mapping model names to `BaseLlm` implementations.

### Core Functionality

```typescript
class LLMRegistry {
  private static llmRegistryDict: Map<string | RegExp, BaseLlmType>;
  private static resolveCache: LRUCache<string, BaseLlmType>;

  static newLlm(model: string): BaseLlm;
  static register<T extends BaseLlm>(llmCls: BaseLlmType): void;
  static resolve(model: string): BaseLlmType;
}
```

### Registration

Register LLM classes with their supported model patterns:

```typescript
import { LLMRegistry, BaseLlm } from '@google/adk';

class MyCustomLlm extends BaseLlm {
  static override readonly supportedModels = [
    /my-model-.*/,
    'specific-custom-model'
  ];

  // ... implementation
}

// Register the class
LLMRegistry.register(MyCustomLlm);
```

Auto-registration happens at module load for built-in models:

```typescript
LLMRegistry.register(Gemini);
LLMRegistry.register(ApigeeLlm);
```

### Model Resolution

The `resolve()` method matches model names against registered patterns:

```typescript
static resolve(model: string): BaseLlmType {
  // Check cache first
  const cachedLlm = LLMRegistry.resolveCache.get(model);
  if (cachedLlm) return cachedLlm;

  // Search registry
  for (const [regex, llmClass] of LLMRegistry.llmRegistryDict.entries()) {
    // Anchor regex to match full string (like Python's re.fullmatch)
    const pattern = new RegExp(
      `^${regex instanceof RegExp ? regex.source : regex}$`,
      regex instanceof RegExp ? regex.flags : undefined
    );

    if (pattern.test(model)) {
      LLMRegistry.resolveCache.set(model, llmClass);
      return llmClass;
    }
  }

  throw new Error(`Model ${model} not found.`);
}
```

### Creating LLM Instances

```typescript
// Via registry (recommended)
const llm = LLMRegistry.newLlm('gemini-2.5-flash');

// Direct instantiation
const llm = new Gemini({ model: 'gemini-2.5-flash' });
```

### LRU Cache

The registry uses a Least Recently Used cache (max size: 32) to avoid creating duplicate instances:

```typescript
class LRUCache<K, V> {
  constructor(maxSize: number);
  get(key: K): V | undefined;
  set(key: K, value: V): void;
}
```

**Cache Behavior:**
- Stores up to 32 recently resolved model-to-class mappings
- Evicts least recently used entry when full
- Maintains insertion order via `Map`

## ApigeeLlm

`ApigeeLlm` extends `Gemini` to integrate with Apigee API Gateway as a proxy for Gemini/Vertex AI.

### Model Name Format

```
apigee/[<provider>/][<version>/]<model_id>
```

**Examples:**
- `apigee/gemini-2.5-flash`
- `apigee/vertex_ai/gemini-2.5-flash`
- `apigee/vertex_ai/v1beta1/gemini-2.5-pro`

### Supported Patterns

```typescript
static override readonly supportedModels = [/apigee\/.*/];
```

### Configuration

```typescript
interface ApigeeLlmParams extends GeminiParams {
  proxyUrl: string;  // Apigee endpoint URL
}

const llm = new ApigeeLlm({
  model: 'apigee/vertex_ai/gemini-2.5-flash',
  proxyUrl: 'https://my-apigee-instance.com/v1/gemini',
  project: 'my-project',
  location: 'us-central1'
});
```

### Backend Detection

```typescript
apigeeToGeminiInitParams() {
  // Detect Vertex AI mode from model name
  if (this.model.startsWith('apigee/vertex_ai/')) {
    return { vertexai: true, ... };
  }
  return { vertexai: false, ... };
}
```

### HTTP Options Override

Routes requests through Apigee proxy:

```typescript
protected override getHttpOptions(): HttpOptions {
  const opts = super.getHttpOptions();
  opts.baseUrl = this.proxyUrl;  // Override base URL
  return opts;
}

protected override getLiveHttpOptions(): HttpOptions {
  const opts = super.getLiveHttpOptions();
  opts.baseUrl = this.proxyUrl;  // For live connections
  return opts;
}
```

### API Version Extraction

```typescript
protected identifyApiVersion(): string {
  // Extract version from model string
  // e.g., "apigee/vertex_ai/v1beta1/gemini-2.5-flash" → "v1beta1"
  const parts = this.model.split('/');
  if (parts.length >= 3 && parts[2].startsWith('v')) {
    return parts[2];
  }
  return super.identifyApiVersion();
}
```

## LlmRequest and LlmResponse

### LlmRequest

Interface representing a request to an LLM:

```typescript
interface LlmRequest {
  model?: string;                        // Model name
  contents: Content[];                   // Conversation history
  config?: GenerateContentConfig;        // Model configuration
  liveConnectConfig: LiveConnectConfig; // Live connection config
  toolsDict: {[key: string]: BaseTool}; // Tool instances (not serialized)
}
```

#### Utility Functions

**appendInstructions()**

```typescript
function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[]
): void {
  const newInstructions = instructions.join('\n\n');
  if (llmRequest.config.systemInstruction) {
    llmRequest.config.systemInstruction += '\n\n' + newInstructions;
  } else {
    llmRequest.config.systemInstruction = newInstructions;
  }
}
```

**appendTools()**

```typescript
function appendTools(
  llmRequest: LlmRequest,
  tools: BaseTool[]
): void {
  const functionDeclarations: FunctionDeclaration[] = [];

  for (const tool of tools) {
    const declaration = tool._getDeclaration();
    if (declaration) {
      functionDeclarations.push(declaration);
      llmRequest.toolsDict[tool.name] = tool;
    }
  }

  if (functionDeclarations.length) {
    if (!llmRequest.config) {
      llmRequest.config = {};
    }
    if (!llmRequest.config.tools) {
      llmRequest.config.tools = [];
    }
    llmRequest.config.tools.push({functionDeclarations});
  }
}
```

**setOutputSchema()**

```typescript
function setOutputSchema(
  llmRequest: LlmRequest,
  schema: SchemaUnion
): void {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  llmRequest.config.responseSchema = schema;
  llmRequest.config.responseMimeType = 'application/json';
}
```

### LlmResponse

Interface representing a response from an LLM:

```typescript
interface LlmResponse {
  content?: Content;                                // Response content
  groundingMetadata?: GroundingMetadata;           // Search grounding info
  partial?: boolean;                                // Unfinished stream chunk
  turnComplete?: boolean;                           // Complete turn in stream
  errorCode?: string;                               // Error code (model-specific)
  errorMessage?: string;                            // Error description
  interrupted?: boolean;                            // User interrupted
  customMetadata?: {[key: string]: unknown};       // Custom labels
  usageMetadata?: GenerateContentResponseUsageMetadata; // Token usage
  finishReason?: FinishReason;                     // Why generation stopped
  liveSessionResumptionUpdate?: LiveServerSessionResumptionUpdate;
  inputTranscription?: Transcription;              // Audio input transcription
  outputTranscription?: Transcription;             // Audio output transcription
}
```

#### createLlmResponse()

Converts `GenerateContentResponse` to `LlmResponse`:

```typescript
function createLlmResponse(
  response: GenerateContentResponse
): LlmResponse {
  const usageMetadata = response.usageMetadata;

  // Success case: has candidates with content
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (candidate.content?.parts && candidate.content.parts.length > 0) {
      return {
        content: candidate.content,
        groundingMetadata: candidate.groundingMetadata,
        usageMetadata,
        finishReason: candidate.finishReason
      };
    }

    // Candidate exists but no content - error
    return {
      errorCode: candidate.finishReason,
      errorMessage: candidate.finishMessage,
      usageMetadata,
      finishReason: candidate.finishReason
    };
  }

  // Prompt feedback (e.g., blocked by safety)
  if (response.promptFeedback) {
    return {
      errorCode: response.promptFeedback.blockReason,
      errorMessage: response.promptFeedback.blockReasonMessage,
      usageMetadata
    };
  }

  // Unknown error
  return {
    errorCode: 'UNKNOWN_ERROR',
    errorMessage: 'Unknown error.',
    usageMetadata
  };
}
```

## Custom LLM Registration

To integrate a custom LLM provider:

### 1. Extend BaseLlm

```typescript
import { BaseLlm, LlmRequest, LlmResponse, BaseLlmConnection } from '@google/adk';

class CustomLlm extends BaseLlm {
  // Define supported model patterns
  static override readonly supportedModels = [
    /custom-model-.*/,
    'specific-model-name'
  ];

  constructor({model, apiKey}: {model: string; apiKey?: string}) {
    super({model});
    this.apiKey = apiKey || process.env.CUSTOM_API_KEY;
  }

  // Implement content generation
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false
  ): AsyncGenerator<LlmResponse, void> {
    // Your implementation
    const response = await this.callCustomApi(llmRequest, stream);

    if (stream) {
      for await (const chunk of response) {
        yield this.convertToLlmResponse(chunk);
      }
    } else {
      yield this.convertToLlmResponse(response);
    }
  }

  // Implement live connection
  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    // Your implementation
    const connection = await this.establishConnection(llmRequest);
    return new CustomLlmConnection(connection);
  }

  private async callCustomApi(request, stream) {
    // Your API call logic
  }

  private convertToLlmResponse(data): LlmResponse {
    // Convert provider response to LlmResponse
    return {
      content: {
        role: 'model',
        parts: [{text: data.text}]
      },
      usageMetadata: {
        promptTokenCount: data.tokens.input,
        candidatesTokenCount: data.tokens.output,
        totalTokenCount: data.tokens.total
      }
    };
  }
}
```

### 2. Register with LLMRegistry

```typescript
import { LLMRegistry } from '@google/adk';

LLMRegistry.register(CustomLlm);
```

### 3. Use Your Custom Model

```typescript
// Via registry
const llm = LLMRegistry.newLlm('custom-model-v1');

// Via agent configuration
const agent = new LlmAgent({
  name: 'my_agent',
  model: 'custom-model-v1',  // Automatically resolves to CustomLlm
  instruction: 'You are a helpful assistant'
});
```

### Requirements Checklist

- [ ] Extend `BaseLlm`
- [ ] Define `static readonly supportedModels`
- [ ] Implement constructor with `{model: string}` signature
- [ ] Implement `generateContentAsync()`
- [ ] Implement `connect()`
- [ ] Convert provider responses to `LlmResponse` format
- [ ] Call `LLMRegistry.register(YourLlmClass)`

## GoogleLLMVariant

Enum distinguishing between Google's two LLM backends:

```typescript
enum GoogleLLMVariant {
  GEMINI_API = 'GEMINI_API',      // Google AI Studio (API key)
  VERTEX_AI = 'VERTEX_AI'          // Vertex AI (ADC)
}
```

### Determining Variant

```typescript
function getGoogleLlmVariant(): GoogleLLMVariant {
  const vertexaiEnv = getBooleanEnvVar('GOOGLE_GENAI_USE_VERTEXAI');
  return vertexaiEnv ? GoogleLLMVariant.VERTEX_AI : GoogleLLMVariant.GEMINI_API;
}
```

### Usage in Code

```typescript
class Gemini extends BaseLlm {
  get apiBackend(): GoogleLLMVariant {
    if (!this._apiBackend) {
      this._apiBackend = this.apiClient.vertexai
        ? GoogleLLMVariant.VERTEX_AI
        : GoogleLLMVariant.GEMINI_API;
    }
    return this._apiBackend;
  }

  protected preprocessRequest(llmRequest: LlmRequest): void {
    if (this.apiBackend === GoogleLLMVariant.GEMINI_API) {
      // Remove Vertex-specific fields
      delete llmRequest.config?.labels;
      removeDisplayNameFromBlobs(llmRequest.contents);
    }
  }
}
```

### Differences Between Variants

| Feature | GEMINI_API | VERTEX_AI |
|---------|------------|-----------|
| Authentication | API Key | Application Default Credentials |
| Configuration | Simpler | Requires project/location |
| Features | Subset | Full feature set |
| Labels support | No | Yes |
| Blob displayName | No | Yes |
| Pricing | Pay-as-you-go | GCP billing |
| Rate limits | Per API key | Per project |

---

## Related Documentation

- [Agents](./agents.md) - Agent configuration and model usage
- [Tools](./tools.md) - Tool integration with models
- [Sessions](./sessions.md) - Session management
- [Events](./events.md) - Event structure and flow
