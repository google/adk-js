# BaseRetrievalTool

`BaseRetrievalTool` is the abstract base of the client-side retrieval tools. It
contributes the function declaration they all share — one string argument named
`query` — so a subclass writes only `runAsync`.

## Which retrieval guide you want

This page is the right one if you are deciding between client-side and
server-side retrieval, or if you are writing a retrieval tool over a store that
is not a vector index. Its siblings:

- [LlamaIndexRetrieval](../llama_index_retrieval/index.md) — you already have a
  LlamaIndex retriever, or anything with a `retrieve` method.
- [FilesRetrieval](../files_retrieval/index.md) — you have a directory of
  documents and want the index built for you.

## Introduction

An agent that answers from a document set needs a way to turn a question into
text worth putting in front of the model. Handing the model the whole corpus
does not scale, and handing it nothing produces confident invention. A retrieval
tool sits between the two: the model decides when to search and what to search
for, your code decides what comes back.

`BaseRetrievalTool` is what makes those tools interchangeable. Every subclass
presents the model with the same one-argument function, so a model that has
learned to call one retrieval tool can call any of them, and swapping the store
behind a tool does not change what the model sees.

## Get started

Subclass it when your corpus has no notion of nodes and scores — a search API, a
database query, a support ticket system. You inherit the declaration and supply
`runAsync`.

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

## How it works

`BaseRetrievalTool` overrides `_getDeclaration` and returns the same
`FunctionDeclaration` shape for every subclass: an object with one `query`
string property described as `The query to retrieve.`, carrying the subclass's
own `name` and `description`. Nothing else varies.

Because the declaration exists, the inherited `BaseTool.processLlmRequest` takes
its normal path. The tool registers itself in `llmRequest.toolsDict` under its
name, and its declaration is appended to the first entry in
`llmRequest.config.tools` that already carries `functionDeclarations`, so every
client-side tool on the agent shares one `Tool` entry rather than adding one
each. Registering in `toolsDict` is what makes the call routable back to this
instance when the model answers with a function call.

The `query` property is not marked required, matching adk-python v0.1.0. A model
is therefore permitted to call the tool with no arguments, and each subclass
decides what the empty query means.

## Configuration options

| Option        | Type     | Default  | Description                              |
| :------------ | :------- | :------- | :--------------------------------------- |
| `name`        | `string` | required | The function name the model calls.       |
| `description` | `string` | required | What the corpus contains, for the model. |

The `description` is the only thing the model has to decide whether to call the
tool, so write it as a statement of what the corpus contains rather than a
label. `name` becomes the function name in the declaration and has to be unique
across the agent's tools.

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

## Limitations

`BaseRetrievalTool` fixes the declaration, so a subclass cannot add a second
argument. A tool that needs a filter, a corpus selector, or a result count is
not a retrieval tool in this sense; extend `BaseTool` and write your own
declaration.

The declaration does not mark `query` required, so a subclass has to handle the
absent case itself.

## Related guides

- [LlamaIndexRetrieval](../llama_index_retrieval/index.md)
- [FilesRetrieval](../files_retrieval/index.md)

## Related samples

- [Retrieval tools](../../../../../samples/tools/retrieval/README.md) - An agent
  with a `LlamaIndexRetrieval` tool over a hand-written retriever.
