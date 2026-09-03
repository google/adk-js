# Retrieval tools

`BaseRetrievalTool` and its subclasses give an agent a single-argument search
tool: the model sends one natural-language `query` and receives one string of
retrieved text. The retrieval runs in your process, so you choose the store, the
chunking, and the ranking.

## Introduction

An agent that answers from a document set needs a way to turn a question into
text worth putting in front of the model. Handing the model the whole corpus
does not scale, and handing it nothing produces confident invention. A retrieval
tool sits between the two: the model decides when to search and what to search
for, your code decides what comes back.

Three classes make up the family in `core/src/tools/retrieval/`:

- `BaseRetrievalTool` is abstract. It contributes the function declaration every
  retrieval tool shares, so a subclass writes only `runAsync`.
- `LlamaIndexRetrieval` answers from a LlamaIndex retriever, or from anything
  shaped like one.
- `FilesRetrieval` extends `LlamaIndexRetrieval` and builds that retriever for
  you from a directory of files.

A fourth class, `VertexRagRetrievalTool`, also puts retrieved text in front of
the model, and it works in a way that has almost nothing in common with these
three. [Choosing between the two](#choosing-between-client-side-and-server-side-retrieval)
covers the difference, which is the decision to make before reading anything
below it.

## Get started

`FilesRetrieval` is the shortest path from a directory of documents to a
grounded agent. It reads the directory, embeds and indexes it, and returns a
tool the agent can call.

```ts
import {FilesRetrieval, LlmAgent} from '@google/adk';

const handbook = await FilesRetrieval.create({
  name: 'employee_handbook',
  description:
    'Looks up company policy on expenses, travel, and equipment in the ' +
    'employee handbook.',
  inputDir: './handbook',
});

export const rootAgent = new LlmAgent({
  name: 'handbook_assistant',
  model: 'gemini-flash-latest',
  instruction:
    'Answer questions about company policy. Call employee_handbook before ' +
    'answering, and base the answer only on the text it returns.',
  tools: [handbook],
});
```

`create` is asynchronous where adk-python's constructor is not, because reading
the directory and building the index are both asynchronous in LlamaIndexTS. It
also needs two optional peer dependencies, `llamaindex` and
`@llamaindex/readers`, which is the subject of [Limitations](#limitations).

The `description` is the only thing the model has to decide whether to call the
tool, so write it as a statement of what the corpus contains rather than a
label. `name` becomes the function name in the declaration and has to be unique
across the agent's tools.

## How it works

`BaseRetrievalTool` overrides `_getDeclaration` and returns the same
`FunctionDeclaration` shape for every subclass: an object with one `query`
string property described as `The query to retrieve.`, carrying the subclass's
own `name` and `description`. Nothing else varies, which is the point — a model
that has learned to call one retrieval tool can call any of them.

Because the declaration exists, the inherited `BaseTool.processLlmRequest` takes
its normal path. The tool registers itself in `llmRequest.toolsDict` under its
name, and its declaration is appended to the first entry in
`llmRequest.config.tools` that already carries `functionDeclarations`, so every
client-side tool on the agent shares one `Tool` entry rather than adding one
each. Registering in `toolsDict` is what makes the call routable back to this
instance when the model answers with a function call.

`LlamaIndexRetrieval.runAsync` reads `args['query']`, coerces it with `String`,
calls `retrieve` on the retriever, and returns the `text` of the first node in
the result. The first node, not the best node: the tool trusts the retriever's
ordering and never re-ranks. It also returns one chunk rather than a list,
matching adk-python, so a retriever that returns three equally relevant
passages contributes only the first to the model's context.

The `query` property is not marked required, matching adk-python v0.1.0. A model
is therefore permitted to call the tool with no arguments, which
`LlamaIndexRetrieval` treats as the empty query rather than as an error.

`FilesRetrieval` adds no retrieval behaviour of its own. `create` loads the
directory with `SimpleDirectoryReader`, indexes the documents with
`VectorStoreIndex.fromDocuments`, and passes `index.asRetriever()` to the
`LlamaIndexRetrieval` constructor. Both packages are loaded through dynamic
imports behind non-literal specifiers, which is what keeps them optional: a
project that never calls `create` neither installs them nor compiles against
them. The load reports progress through the ADK logger at info level, where
adk-python prints to standard output.

## Choosing between client-side and server-side retrieval

`VertexRagRetrievalTool`, in `core/src/tools/vertex_rag_retrieval_tool.ts`,
predates this family and is not part of it. Both put retrieved text in front of
the model; they disagree about who does the retrieving.

|                          | `BaseRetrievalTool` subclasses                     | `VertexRagRetrievalTool`                                 |
| :----------------------- | :------------------------------------------------- | :------------------------------------------------------- |
| Base class               | `BaseTool`                                         | `BuiltInTool`                                            |
| Who retrieves            | Your process, through `runAsync`                   | The model, server-side                                   |
| How it reaches the model | A function declaration the model calls             | A `retrieval.vertexRagStore` entry in the request config |
| Where the text appears   | A function response in the conversation            | Grounding metadata on the response                       |
| Corpus                   | Anything you can write a `retrieve` method against | A Vertex AI RAG corpus                                   |
| Backend                  | Any model the agent can call                       | Vertex AI                                                |

A `BuiltInTool` is a tool the model runs itself. It has no function
declaration, so `BuiltInTool.processLlmRequest` skips the declaration path
entirely and only writes the configuration onto the request. It registers its
name in `toolsDict` so that a model which mistakenly emits an explicit function
call can still be routed, and `runAsync` answers that call by telling the model
the tool is not callable and to use the grounding metadata already present.

The practical consequences:

- **You can see and shape what a client-side tool returns.** It is a value
  returned from your code, so you can log it, truncate it, cache it, or post-
  process it. Server-side retrieval happens inside the model call, and the text
  reaches you as grounding metadata after the fact.
- **A client-side tool works against any store and any model.**
  `VertexRagRetrievalTool` needs a Vertex AI RAG corpus and the Vertex AI
  backend; the genai type documents `VertexRagStoreRagResource` as unsupported
  on the Gemini API.
- **Server-side retrieval costs you no round trip.** A client-side tool call is
  a full extra turn: the model emits a function call, the framework runs the
  tool, and the model is called again with the response. Vertex AI RAG retrieves
  inside the one call.
- **`VertexRagRetrievalTool` holds one corpus.** The Vertex AI RAG Engine
  supports a single corpus per `ragResources` array, so a second corpus means a
  second tool instance.

Reach for `LlamaIndexRetrieval` or `FilesRetrieval` when the corpus is yours,
when it lives somewhere other than Vertex AI, or when you need to inspect what
was retrieved. Reach for `VertexRagRetrievalTool` when the corpus is already in
Vertex AI RAG and you are running on Vertex AI, where the managed path costs
less latency and no retrieval code.

```ts
import {LlmAgent, VertexRagRetrievalTool} from '@google/adk';

const ragTool = new VertexRagRetrievalTool({
  ragResources: [
    {
      ragCorpus:
        'projects/my-project/locations/us-central1/ragCorpora/my-corpus',
    },
  ],
  similarityTopK: 5,
});

export const rootAgent = new LlmAgent({
  name: 'grounded_assistant',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions about company policy.',
  tools: [ragTool],
});
```

The constructor takes a genai `VertexRagStore` positionally, unlike the named
parameter object the retrieval family uses, and the tool's `name` is fixed at
`vertex_rag_retrieval` rather than being yours to choose.

## Configuration options

### LlamaIndexRetrieval

| Option        | Type                  | Default  | Description                              |
| :------------ | :-------------------- | :------- | :--------------------------------------- |
| `name`        | `string`              | required | The function name the model calls.       |
| `description` | `string`              | required | What the corpus contains, for the model. |
| `retriever`   | `LlamaIndexRetriever` | required | The object that answers a query.         |

`retriever` is typed against a structural interface with a single method,
`retrieve(query: string): Promise<LlamaIndexNodeWithScore[]>`. Nothing in the
module imports `llamaindex`, which mirrors adk-python keeping its import under
`TYPE_CHECKING`. Anything satisfying that method works, so a hand-written
retriever, a fake in a test, and a real `VectorStoreIndex` retriever are
interchangeable. The retriever is exposed as a readonly `retriever` field, which
is what lets a test assert which one a tool was built with.

`LlamaIndexNodeWithScore` carries `node` and an optional `score`. The tool reads
`node.text` and ignores `score`, so the score is documentation for your own
ranking rather than an input to the tool.

### FilesRetrieval

| Option        | Type                  | Default                    | Description                                |
| :------------ | :-------------------- | :------------------------- | :----------------------------------------- |
| `name`        | `string`              | required                   | The function name the model calls.         |
| `description` | `string`              | required                   | What the corpus contains, for the model.   |
| `inputDir`    | `string`              | required                   | The directory whose files are indexed.     |
| `retriever`   | `LlamaIndexRetriever` | required, constructor only | A retriever already built over `inputDir`. |

`create` takes the first three and builds the fourth. The constructor takes all
four, which is the path for a caller who built the index some other way — a
persisted vector store, a different reader, a retriever with tuned `topK` — and
still wants the tool to record which directory it came from. `inputDir` is
exposed as a readonly field and is otherwise inert after construction: nothing
re-reads the directory, so a file added afterwards is invisible until you build
a new tool.

The two shapes have separate types, `FilesRetrievalParams` for `create` and
`FilesRetrievalConstructorParams` for the constructor, so passing the wrong one
is a compile error rather than a missing retriever at run time.

## Advanced applications

### Supplying your own retriever

A corpus that is not a directory of files, or an index you build and persist
yourself, goes through `LlamaIndexRetrieval` directly. Implement
`LlamaIndexRetriever` and return nodes in the order you want them considered,
because the tool takes the first one.

```ts
import {
  LlamaIndexNodeWithScore,
  LlamaIndexRetrieval,
  LlamaIndexRetriever,
} from '@google/adk';

class ProductCatalogRetriever implements LlamaIndexRetriever {
  async retrieve(query: string): Promise<LlamaIndexNodeWithScore[]> {
    // Your own search, returning rows with a summary and a relevance score.
    const rows = await searchCatalog(query);
    return rows
      .map((row) => ({node: {text: row.summary}, score: row.relevance}))
      .sort((a, b) => b.score - a.score);
  }
}

const catalog = new LlamaIndexRetrieval({
  name: 'product_catalog',
  description: 'Product names, prices, and availability.',
  retriever: new ProductCatalogRetriever(),
});
```

### Retrieving from a service that is not a vector store

When there is no notion of nodes and scores at all — a search API, a database
query, a support ticket system — subclass `BaseRetrievalTool` and skip the
LlamaIndex shapes entirely. You inherit the one-argument `query` declaration and
supply `runAsync`.

```ts
import {BaseRetrievalTool, RunAsyncToolRequest} from '@google/adk';

class SupportSearchRetrieval extends BaseRetrievalTool {
  constructor(private readonly endpoint: string) {
    super({
      name: 'support_search',
      description: 'Searches resolved support tickets for similar issues.',
    });
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const query = String(args['query'] ?? '');
    const response = await fetch(
      `${this.endpoint}?q=${encodeURIComponent(query)}`,
    );
    return await response.text();
  }
}
```

Coerce `args['query']` rather than trusting it, and decide what an absent query
means for your store, because the declaration does not mark it required.
`runAsync` returns `unknown`, so a structured object is as valid a response as a
string; it is serialized into the function response the model reads.

### Giving one agent several corpora

Each corpus is a separate tool with its own `name` and `description`. The model
routes between them on the descriptions alone, so make them distinguish the
corpora rather than describe retrieval.

```ts
import {FilesRetrieval, LlmAgent} from '@google/adk';

const policies = await FilesRetrieval.create({
  name: 'hr_policies',
  description: 'Employment policy: leave, expenses, and travel.',
  inputDir: './docs/hr',
});

const runbooks = await FilesRetrieval.create({
  name: 'oncall_runbooks',
  description: 'Operational runbooks for production incidents.',
  inputDir: './docs/runbooks',
});

export const rootAgent = new LlmAgent({
  name: 'internal_assistant',
  model: 'gemini-flash-latest',
  instruction: 'Answer from the retrieved documents, and say which corpus.',
  tools: [policies, runbooks],
});
```

## Limitations

`FilesRetrieval.create` needs `llamaindex` and `@llamaindex/readers`, neither of
which is a dependency of `@google/adk`. Both are loaded through dynamic imports,
so a missing one surfaces at the `create` call rather than at import time, and
the error names the package to install. Nothing in the type signatures reveals
the requirement, which is why it is worth stating before a reader ships a build
that fails on first use. `create` also depends on a configured LlamaIndex
embedding model; `VectorStoreIndex.fromDocuments` fails without one.

An empty retrieval is an error. `LlamaIndexRetrieval.runAsync` throws
`{name} retrieved no results for the query.` when the retriever returns nothing,
rather than returning an empty string, so a corpus that legitimately has no
answer for a question produces a tool error the agent has to handle.
adk-python indexes `[0]` unguarded and raises `IndexError` in the same case, so
the behaviour matches and only the message differs.

Only the first node is used. There is no option to return the top _k_ chunks
joined together, so widening the context means returning wider chunks from the
retriever, or wrapping several nodes into one node's `text` before the tool sees
them.

`LlamaIndexNode.text` is optional, so a retriever that returns a node without
text makes `runAsync` resolve to `undefined`. The tool does not check for that
case, because a `TextNode` from a vector retriever always carries text.

`FilesRetrieval` indexes once, at `create`. There is no refresh, no
invalidation, and no incremental update.

## Related samples

- [Retrieval tools](../../../../samples/tools/retrieval/agent.ts) - An agent
  with a `LlamaIndexRetrieval` tool over a hand-written retriever, and an
  optional `FilesRetrieval` tool over a real directory.
