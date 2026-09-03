# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript implementation. For the official ADK documentation, visit [adk.dev](https://adk.dev/). For the generated API reference, run `npm run docs`.

A guide covers one code unit in more depth than the published documentation carries, for a developer calling it from their own application. Guides mirror the source path under `core/src/`, so `core/src/tools/retrieval/` is documented at `tools/retrieval/index.md`.

This index is the only table of contents. A guide that is not listed here is unreachable, so add the entry in the same change that adds the guide.

## Index

### Tools

- [Retrieval tools](tools/retrieval/index.md) - `BaseRetrievalTool`, `LlamaIndexRetrieval` and `FilesRetrieval`, and how client-side retrieval differs from `VertexRagRetrievalTool`.
