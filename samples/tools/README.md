# Tool samples

Runnable TypeScript agents for the tools in `@google/adk`. One directory per
tool family, flat rather than grouped, because these samples are not ports of a
single documentation page — each one links the guide under `docs/guides/` that
explains the classes it uses.

Each directory exports a `rootAgent` that runs with the ADK CLI. A sample fills
in whatever a real deployment would supply from outside, such as a corpus or an
index, with the smallest plausible stand-in and says so in its header comment.

## Running

Build once, then run any sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/tools/retrieval/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately, in CI and
locally:

```bash
npm run ts:check:samples
```

The CLI is interactive: type a message and press Enter to send it to the agent;
type `exit` to quit. Pipe a single message to run one turn and exit:

```bash
echo "how long do I have to file an expense report?" | npm run sample -- samples/tools/retrieval/agent.ts
```

## Coverage

Lint, Prettier, the license check and `ts:check:samples` all read these files,
so a syntax, style, license or type error fails CI. Nothing executes them.

The `tests/integration/docs_samples` suite that constructs and runs the
workflow samples resolves its `SAMPLES_ROOT` to `samples/workflows`, so it does
not reach this directory. Widening it would mean supplying an API key or a
recorded fixture for every sample here, since these samples are agents rather
than function-only graphs.

## Requirements

Every sample in this category calls a live model. Set `GEMINI_API_KEY`; a
`.env` file in the working directory is loaded automatically.

`samples/tools/retrieval` has one optional half. Set `ADK_SAMPLE_DOCS_DIR` to a
directory of documents to add a `FilesRetrieval` tool over it, which needs the
optional peer dependencies and a configured LlamaIndex embedding model:

```bash
npm install llamaindex @llamaindex/readers
export ADK_SAMPLE_DOCS_DIR=./my-docs
```

Left unset, the sample runs on the corpus written into the file.

## Samples

| Sample      | Shows                                                                                  | Key | Extra                                      |
| ----------- | -------------------------------------------------------------------------------------- | --- | ------------------------------------------ |
| `retrieval` | `LlamaIndexRetrieval` over a hand-written retriever, plus an optional `FilesRetrieval` | ✅  | `llamaindex` for the `FilesRetrieval` half |

## Worth knowing

- **A retrieval tool answers with one chunk, not a ranked list.**
  `LlamaIndexRetrieval` returns the text of the highest-scoring node and
  discards the rest, matching adk-python. A retriever that returns its results
  unsorted therefore picks the answer by accident.
- **`llamaindex` is an optional peer dependency, and nothing imports it
  statically.** `LlamaIndexRetrieval` is typed against a structural
  `LlamaIndexRetriever` interface, so any object with a `retrieve(query)`
  method works and the package is only needed by `FilesRetrieval.create`.
- **A client-side retrieval tool and `VertexRagRetrievalTool` are not
  interchangeable.** The first runs in your process and hands the model text;
  the second adds a `retrieval.vertexRagStore` entry to the request config and
  the model retrieves server-side. See the guide below for how to choose.

## See also

- [BaseRetrievalTool](../../docs/guides/tools/retrieval/base_retrieval_tool/index.md) - The abstract base, and how client-side retrieval differs from `VertexRagRetrievalTool`.
- [LlamaIndexRetrieval](../../docs/guides/tools/retrieval/llama_index_retrieval/index.md) - Answers from any object with a `retrieve` method.
- [FilesRetrieval](../../docs/guides/tools/retrieval/files_retrieval/index.md) - Builds the retriever from a directory of documents.
