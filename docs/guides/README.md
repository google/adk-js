# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript implementation. For the official ADK documentation, visit [adk.dev](https://adk.dev/). For the generated API reference, run `npm run docs`.

A guide covers one code unit in more depth than the published documentation carries, for a developer calling it from their own application. Guides mirror the source path under `core/src/`, so `core/src/tools/retrieval/files_retrieval.ts` is documented at `tools/retrieval/files_retrieval/index.md`.

This index is the only table of contents. A guide that is not listed here is unreachable, so add the entry in the same change that adds the guide.

## Index

### Tools

#### Retrieval

Client-side retrieval tools. The agent calls a one-argument search function, your code answers it, and you choose the store, the chunking and the ranking. Start with `BaseRetrievalTool` if you are deciding between these and server-side retrieval.

- [BaseRetrievalTool](tools/retrieval/base_retrieval_tool/index.md) - The abstract base, and how client-side retrieval differs from `VertexRagRetrievalTool`.
- [LlamaIndexRetrieval](tools/retrieval/llama_index_retrieval/index.md) - Answers from a LlamaIndex retriever, or anything with a `retrieve` method.
- [FilesRetrieval](tools/retrieval/files_retrieval/index.md) - Builds the retriever for you from a directory of documents.
