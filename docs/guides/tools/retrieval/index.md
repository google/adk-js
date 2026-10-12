# Retrieval tools

The `tools/retrieval` subsystem provides client-side retrieval tools that expose a single `query` string parameter to an `LlmAgent` and execute search in application code. Every tool in the family shares the function declaration defined by `BaseRetrievalTool`, so switching from an in-memory retriever to a vector index or a custom search endpoint does not change the tool interface presented to the model.

Each class in the subsystem targets a different starting point, and the per-class guides cover individual units in detail:

- [BaseRetrievalTool](base_retrieval_tool/index.md) - Abstract base class for custom retrieval stores and comparison with server-side `VertexRagRetrievalTool`.
- [LlamaIndexRetrieval](llama_index_retrieval/index.md) - Retrieval tool backed by any object that implements `retrieve(query)`.
- [FilesRetrieval](files_retrieval/index.md) - Retrieval tool that reads and indexes a local directory of documents with LlamaIndexTS.

## Introduction

Grounding an agent over a document corpus requires turning a model-generated search query into relevant passages without placing the entire corpus in the prompt. Client-side retrieval tools in `@google/adk` model retrieval as a standard `BaseTool` function call: the model decides when to search and emits a function call with a `query` string, the ADK runner executes `runAsync` in your process, and the retrieved result returns to the model as a `functionResponse` event.

The subsystem exports three classes, one type guard, and five TypeScript interfaces:

- `BaseRetrievalTool` and `isBaseRetrievalTool` define the shared `FunctionDeclaration` contract and cross-package runtime type guard for all client-side retrieval tools.
- `LlamaIndexRetrieval`, `LlamaIndexRetriever`, `LlamaIndexNodeWithScore`, `LlamaIndexNode`, and `LlamaIndexRetrievalParams` connect any structural `retrieve(query)` implementation to an agent without importing `llamaindex` at compile time or startup.
- `FilesRetrieval`, `FilesRetrievalParams`, and `FilesRetrievalConstructorParams` build a `LlamaIndexRetrieval` tool from a directory on disk through `FilesRetrieval.create` or wrap an already constructed retriever along with its source `inputDir`.

## Get started

The following example implements a structural `LlamaIndexRetriever`, wraps it in `LlamaIndexRetrieval`, and attaches the tool to an `LlmAgent`.

```ts
import {
  LlamaIndexNodeWithScore,
  LlamaIndexRetrieval,
  LlamaIndexRetriever,
  LlmAgent,
} from '@google/adk';

class PolicyRetriever implements LlamaIndexRetriever {
  constructor(private readonly passages: readonly string[]) {}

  async retrieve(query: string): Promise<LlamaIndexNodeWithScore[]> {
    const terms = query.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    return this.passages
      .map((text) => {
        const lower = text.toLowerCase();
        return {
          node: {text},
          score: terms.filter((term) => lower.includes(term)).length,
        };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
}

export const policyTool = new LlamaIndexRetrieval({
  name: 'search_policy',
  description: 'Searches company policy on expenses, travel, and equipment.',
  retriever: new PolicyRetriever([
    'Expenses: submit expense reports within 30 days of purchase.',
    'Travel: book economy flights through the corporate travel portal.',
  ]),
});

export const rootAgent = new LlmAgent({
  name: 'policy_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers company policy questions from retrieved passages.',
  instruction:
    'Call search_policy before answering policy questions and rely on the returned text.',
  tools: [policyTool],
});
```

## How it works

1. **Shared function declaration in `BaseRetrievalTool`**: `BaseRetrievalTool` extends `BaseTool` and overrides `_getDeclaration()` to emit a `@google/genai` `FunctionDeclaration` with the tool's `name`, `description`, and a single `OBJECT` schema containing one `query` property of type `Type.STRING` with description `'The query to retrieve.'`. The parameter schema omits the `required` array, so subclasses coerce missing `args['query']` values before querying their backing store.
2. **Request packing via `BaseTool.processLlmRequest`**: Because `_getDeclaration()` returns a non-null `FunctionDeclaration`, the inherited `BaseTool.processLlmRequest` registers the tool instance under `llmRequest.toolsDict[this.name]` and appends the declaration to the shared `functionDeclarations` entry inside `llmRequest.config.tools`. Multiple retrieval and function tools on the same agent share a single `Tool` entry in `llmRequest.config.tools`.
3. **Cross-bundle type narrowing with `isBaseRetrievalTool`**: Every `BaseRetrievalTool` instance sets the global symbol property `Symbol.for('google.adk.baseRetrievalTool')` to `true`. Calling `isBaseRetrievalTool(value)` checks for that symbol rather than using `instanceof`, so the check succeeds even when multiple copies of `@google/adk` exist in the same runtime.
4. **Structural retrieval in `LlamaIndexRetrieval`**: `LlamaIndexRetrieval.runAsync({args})` converts `args['query']` to a string via `String(args['query'] ?? '')` and passes it to `this.retriever.retrieve(query)`. It reads the first element `nodes[0]` from the returned `LlamaIndexNodeWithScore[]` array, throws `Error('<name> retrieved no results for the query.')` if the array is empty, and returns `nodes[0].node.text`. Because `LlamaIndexRetrieval` never re-ranks results, the retriever must return nodes ordered from most relevant to least relevant.
5. **Lazy directory indexing in `FilesRetrieval`**: `FilesRetrieval` extends `LlamaIndexRetrieval` and records `inputDir` on the instance. Calling `await FilesRetrieval.create({name, description, inputDir})` logs `Loading data from <inputDir>` through the ADK `logger` at `info` level, dynamically imports `@llamaindex/readers/directory` and `llamaindex`, loads the directory with `new SimpleDirectoryReader().loadData({directoryPath: inputDir})`, builds a vector index with `VectorStoreIndex.fromDocuments(documents)`, and constructs `new FilesRetrieval({...params, retriever: index.asRetriever()})`.

## Configuration options

### `BaseToolParams` for `BaseRetrievalTool`

`BaseRetrievalTool` inherits the `BaseToolParams` constructor parameter interface from `BaseTool`.

| Option          | Type      | Default  | Description                                                                                  |
| :-------------- | :-------- | :------- | :------------------------------------------------------------------------------------------- |
| `name`          | `string`  | Required | Function name exposed in the `FunctionDeclaration` and registered in `llmRequest.toolsDict`. |
| `description`   | `string`  | Required | Natural-language description telling the model what corpus the tool searches.                |
| `isLongRunning` | `boolean` | `false`  | Marks the tool as a long-running operation when set to `true`.                               |

The `description` field is the routing signal the model uses to choose among multiple retrieval tools, so state which documents or domain the corpus covers.

### `LlamaIndexRetrievalParams` and structural retriever interfaces

`LlamaIndexRetrieval` is configured through `LlamaIndexRetrievalParams` and interacts with its retriever through `LlamaIndexRetriever`, `LlamaIndexNodeWithScore`, and `LlamaIndexNode`.

| Interface / Property                    | Type                                                    | Default     | Description                                                                      |
| :-------------------------------------- | :------------------------------------------------------ | :---------- | :------------------------------------------------------------------------------- |
| `LlamaIndexRetrievalParams.name`        | `string`                                                | Required    | Tool name registered in `toolsDict` and exposed to the model.                    |
| `LlamaIndexRetrievalParams.description` | `string`                                                | Required    | Corpus description included in the `FunctionDeclaration`.                        |
| `LlamaIndexRetrievalParams.retriever`   | `LlamaIndexRetriever`                                   | Required    | Structural retriever object stored on the readonly `retriever` field.            |
| `LlamaIndexRetriever.retrieve`          | `(query: string) => Promise<LlamaIndexNodeWithScore[]>` | Required    | Asynchronous method that returns candidate text chunks ordered by relevance.     |
| `LlamaIndexNodeWithScore.node`          | `LlamaIndexNode`                                        | Required    | Node wrapper containing the chunk text.                                          |
| `LlamaIndexNodeWithScore.score`         | `number`                                                | `undefined` | Optional relevance score used by the retriever when sorting results.             |
| `LlamaIndexNode.text`                   | `string`                                                | `undefined` | Retrieved text returned to the model from the first element of the result array. |

`LlamaIndexRetrieval` exposes `retriever` as a `readonly` instance property. During `runAsync`, the tool reads `nodes[0].node.text` and ignores `score`, so any score thresholding or sorting must happen inside `retrieve(query)`.

### `FilesRetrievalParams` and `FilesRetrievalConstructorParams`

`FilesRetrieval.create` accepts `FilesRetrievalParams`, while `new FilesRetrieval(params)` accepts `FilesRetrievalConstructorParams`.

| Interface / Option                          | Type                  | Default  | Description                                                                         |
| :------------------------------------------ | :-------------------- | :------- | :---------------------------------------------------------------------------------- |
| `FilesRetrievalParams.name`                 | `string`              | Required | Tool name exposed to the model.                                                     |
| `FilesRetrievalParams.description`          | `string`              | Required | Description of the indexed directory contents.                                      |
| `FilesRetrievalParams.inputDir`             | `string`              | Required | Directory path passed to `SimpleDirectoryReader.loadData` and stored on `inputDir`. |
| `FilesRetrievalConstructorParams.retriever` | `LlamaIndexRetriever` | Required | Pre-built retriever used when constructing `FilesRetrieval` synchronously.          |

Separating `FilesRetrievalParams` from `FilesRetrievalConstructorParams` ensures at compile time that callers either build the index asynchronously through `FilesRetrieval.create` or provide an existing `retriever` to `new FilesRetrieval`.

## Advanced applications

### Writing a custom `BaseRetrievalTool` and checking instances with `isBaseRetrievalTool`

Subclass `BaseRetrievalTool` directly when your search backend returns records directly rather than LlamaIndex nodes, and use `isBaseRetrievalTool` to inspect an agent's configured tools.

```ts
import {
  BaseRetrievalTool,
  isBaseRetrievalTool,
  RunAsyncToolRequest,
} from '@google/adk';

export class TicketSearchRetrieval extends BaseRetrievalTool {
  constructor(private readonly tickets: Readonly<Record<string, string>>) {
    super({
      name: 'search_tickets',
      description: 'Searches resolved engineering tickets by keyword.',
    });
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const query = String(args['query'] ?? '').toLowerCase();
    const match = Object.entries(this.tickets).find(
      ([key, body]) =>
        key.toLowerCase().includes(query) || body.toLowerCase().includes(query),
    );
    return match ? `${match[0]}: ${match[1]}` : 'No matching ticket found.';
  }
}

const ticketTool = new TicketSearchRetrieval({
  'INC-101': 'Increase connection pool timeout to 30 seconds.',
});

const isRetrieval = isBaseRetrievalTool(ticketTool);
```

### Indexing a local directory or supplying a custom retriever with `FilesRetrieval`

Use `FilesRetrieval.create` to load and index a directory in one call, or construct `FilesRetrieval` directly when you configure the LlamaIndex index and retriever yourself.

```ts
import {FilesRetrieval, LlamaIndexRetriever} from '@google/adk';

export async function createRunbookTools(
  customRetriever: LlamaIndexRetriever,
): Promise<FilesRetrieval[]> {
  const indexedDirectoryTool = await FilesRetrieval.create({
    name: 'search_runbooks',
    description:
      'Searches incident response runbooks from the local directory.',
    inputDir: './runbooks',
  });

  const preconfiguredDirectoryTool = new FilesRetrieval({
    name: 'search_archived_runbooks',
    description: 'Searches archived runbooks using a pre-configured retriever.',
    inputDir: './archive',
    retriever: customRetriever,
  });

  return [indexedDirectoryTool, preconfiguredDirectoryTool];
}
```

### Choosing between client-side retrieval and `VertexRagRetrievalTool`

`@google/adk` also exports `VertexRagRetrievalTool`, which extends `BuiltInTool` rather than `BaseRetrievalTool`. The table below summarizes how client-side retrieval tools compare with `VertexRagRetrievalTool`.

| Characteristic       | `BaseRetrievalTool` subclasses                         | `VertexRagRetrievalTool`                                  |
| :------------------- | :----------------------------------------------------- | :-------------------------------------------------------- |
| Base class           | `BaseTool`                                             | `BuiltInTool`                                             |
| Where retrieval runs | Client-side in your Node.js or browser process         | Server-side inside Vertex AI                              |
| Request modification | Appends a `FunctionDeclaration` to `config.tools`      | Appends `{retrieval: {vertexRagStore}}` to `config.tools` |
| Tool name            | Configured per instance via `name`                     | Fixed to `'vertex_rag_retrieval'`                         |
| Result delivery      | Returned from `runAsync` as a `functionResponse` event | Attached by the model backend as grounding metadata       |

Use `BaseRetrievalTool`, `LlamaIndexRetrieval`, or `FilesRetrieval` when your documents live outside Vertex AI RAG, when you run against the Gemini Developer API, or when you want to inspect and transform retrieved chunks in TypeScript before the model sees them. Use `VertexRagRetrievalTool` when your corpus is hosted in Vertex AI RAG Engine and you want server-side grounding in a single model turn.

```ts
import {LlmAgent, VertexRagRetrievalTool} from '@google/adk';

const vertexRagTool = new VertexRagRetrievalTool({
  ragResources: [
    {
      ragCorpus:
        'projects/my-project/locations/us-central1/ragCorpora/company-handbook',
    },
  ],
  similarityTopK: 5,
});

export const vertexGroundedAgent = new LlmAgent({
  name: 'vertex_grounded_assistant',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions grounded in the company handbook corpus.',
  tools: [vertexRagTool],
});
```

## Limitations

- **Single optional `query` parameter**: `BaseRetrievalTool._getDeclaration()` defines only a `query` string property and does not mark `query` in `parameters.required`. Subclasses that need extra arguments such as metadata filters or `topK` overrides should extend `BaseTool` or `FunctionTool` directly, and implementations of `runAsync` must handle an omitted `args['query']`.
- **Single chunk return and empty-result error in `LlamaIndexRetrieval`**: `LlamaIndexRetrieval.runAsync` returns only `nodes[0].node.text` and throws `Error('<name> retrieved no results for the query.')` when `retrieve(query)` returns an empty array. If `nodes[0].node.text` is `undefined`, `runAsync` resolves to `undefined`. To provide multiple chunks in one call, concatenate them in your `LlamaIndexRetriever.retrieve` implementation before returning the top node.
- **Optional peer dependencies and Node entry point for `FilesRetrieval`**: `FilesRetrieval` is exported from the Node.js entry point `@google/adk` and not from `@google/adk/web`, whereas `BaseRetrievalTool`, `isBaseRetrievalTool`, and `LlamaIndexRetrieval` are exported from both entry points. `FilesRetrieval.create` dynamically imports `llamaindex` and `@llamaindex/readers/directory` at call time and requires a configured LlamaIndex embedding model; if either package is missing, `create` throws an `Error` naming the package to install. `FilesRetrieval` indexes `inputDir` once during `create` and does not watch the directory for later file changes.

## Related samples

- [samples/tools/retrieval/](../../../../samples/tools/retrieval/README.md) - Grounded question-answering agent demonstrating `LlamaIndexRetrieval` with a custom keyword retriever and optional directory indexing with `FilesRetrieval`.
- [Tool samples](../../../../samples/tools/README.md) - Overview of all tool samples, required environment variables, and sample type-checking.

## Related guides

- [BaseRetrievalTool](base_retrieval_tool/index.md) - Detailed guide to the abstract base class and client-side versus server-side retrieval.
- [LlamaIndexRetrieval](llama_index_retrieval/index.md) - Detailed guide to wrapping a structural `LlamaIndexRetriever`.
- [FilesRetrieval](files_retrieval/index.md) - Detailed guide to indexing local document directories with `FilesRetrieval.create`.
- [Tools](../index.md) - Overview of `BaseTool`, `FunctionTool`, `AgentTool`, `ToolContext`, and built-in model tools.
