# FilesRetrieval

`FilesRetrieval` builds a retrieval tool from a directory of documents. It reads
the directory, embeds and indexes it, and gives the agent a tool that answers
from those files.

## Which retrieval guide you want

This page is the right one if your corpus is a directory on disk. Its siblings:

- [LlamaIndexRetrieval](../llama_index_retrieval/index.md) — you already have a
  retriever, or your corpus is not a directory.
- [BaseRetrievalTool](../base_retrieval_tool/index.md) — your store has no
  notion of nodes and scores, or you are still choosing between client-side and
  server-side retrieval.

## Introduction

This is the shortest path from a folder of documents to a grounded agent, and
the only class in the family that builds an index for you. It extends
[LlamaIndexRetrieval](../llama_index_retrieval/index.md) and adds no retrieval
behaviour of its own — everything about how a query is answered is described in
that guide.

## Get started

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
also needs two optional peer dependencies, which is the subject of
[Limitations](#limitations).

## How it works

`create` loads the directory with `SimpleDirectoryReader`, indexes the documents
with `VectorStoreIndex.fromDocuments`, and passes `index.asRetriever()` to the
`LlamaIndexRetrieval` constructor. Both packages are loaded through dynamic
imports behind non-literal specifiers, which is what keeps them optional: a
project that never calls `create` neither installs them nor compiles against
them. The load reports progress through the ADK logger at info level, where
adk-python prints to standard output.

Answering a query is entirely inherited. See
[LlamaIndexRetrieval](../llama_index_retrieval/index.md#how-it-works).

## Configuration options

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

`FilesRetrieval` indexes once, at `create`. There is no refresh, no
invalidation, and no incremental update, so a file added afterwards is invisible
until you build a new tool.

The limitations inherited from
[LlamaIndexRetrieval](../llama_index_retrieval/index.md#limitations) apply too:
only the first node is used, and an empty retrieval throws.

## Related guides

- [LlamaIndexRetrieval](../llama_index_retrieval/index.md)
- [BaseRetrievalTool](../base_retrieval_tool/index.md)

## Related samples

- [Retrieval tools](../../../../../samples/tools/retrieval/README.md) - Includes
  an optional `FilesRetrieval` tool over a real directory.
