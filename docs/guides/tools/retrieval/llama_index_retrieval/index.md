# LlamaIndexRetrieval

`LlamaIndexRetrieval` turns any object with a `retrieve` method into a retrieval
tool. It sends the model's `query` to that object and returns the text of the
first node it gets back.

## Which retrieval guide you want

This page is the right one if you already have a retriever, or can write one
over your own store. Its siblings:

- [FilesRetrieval](../files_retrieval/index.md) — you have a directory of
  documents and want the retriever built for you.
- [BaseRetrievalTool](../base_retrieval_tool/index.md) — your store has no
  notion of nodes and scores, or you are still choosing between client-side and
  server-side retrieval.

## Introduction

The retriever is the part that differs between corpora, and this class is the
part that does not. It holds the tool identity the model sees and the call into
your store, and nothing else — no chunking, no ranking, no embedding. Those are
decisions the retriever already made.

Because the retriever is typed structurally, a hand-written object, a fake in a
test, and a real LlamaIndex `VectorStoreIndex` retriever are interchangeable.
Nothing in the module imports `llamaindex`, which mirrors adk-python keeping its
import under `TYPE_CHECKING`.

## Get started

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

Return nodes in the order you want them considered, because the tool takes the
first one and never re-ranks.

## How it works

`runAsync` reads `args['query']`, coerces it with `String`, calls `retrieve` on
the retriever, and returns the `text` of the first node in the result. The first
node, not the best node: the tool trusts the retriever's ordering. It also
returns one chunk rather than a list, matching adk-python, so a retriever that
returns three equally relevant passages contributes only the first to the
model's context.

The declaration comes from
[BaseRetrievalTool](../base_retrieval_tool/index.md), so the tool registers in
`toolsDict` and shares one `Tool` entry with the agent's other client-side
tools.

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

## Limitations

An empty retrieval is an error. `runAsync` throws
`{name} retrieved no results for the query.` when the retriever returns nothing,
rather than returning an empty string, so a corpus that legitimately has no
answer for a question produces a tool error the agent has to handle. adk-python
indexes `[0]` unguarded and raises `IndexError` in the same case, so the
behaviour matches and only the message differs.

Only the first node is used. There is no option to return the top _k_ chunks
joined together, so widening the context means returning wider chunks from the
retriever, or wrapping several nodes into one node's `text` before the tool sees
them.

`LlamaIndexNode.text` is optional, so a retriever that returns a node without
text makes `runAsync` resolve to `undefined`. The tool does not check for that
case, because a `TextNode` from a vector retriever always carries text.

## Related guides

- [BaseRetrievalTool](../base_retrieval_tool/index.md)
- [FilesRetrieval](../files_retrieval/index.md)

## Related samples

- [Retrieval tools](../../../../../samples/tools/retrieval/README.md) - An agent
  with a `LlamaIndexRetrieval` tool over a hand-written retriever.
