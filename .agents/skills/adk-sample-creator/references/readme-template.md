# Sample category README structure

adk-js has no per-sample `README.md`. Each category directory has one
`README.md` covering every sample in it, and each sample contributes a row to
its table. The content adk-python put in a per-sample README is split between
two places here:

| adk-python per-sample README | adk-js home                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| Overview                     | The `Shows` column of the category table, plus the sample's header comment. |
| Sample Inputs                | The header comment, as a `Try "…"` line, when the sample parses its input.  |
| Graph                        | Dropped. The `edges` array is the diagram.                                  |
| How To                       | The header comment.                                                         |
| Related Guides               | The category README's own links, so one list serves every sample.           |

## Sections

Write the category README in this order. `samples/workflows/README.md` is the
worked example for all of it.

### Title and scope

One heading and a paragraph: what the category holds, and what a directory in
it corresponds to. State the mapping rule, because it is what tells a
contributor where a new sample goes:

> Runnable TypeScript workflows for each section of the ADK
> [Graph Workflows docs](https://adk.dev/graphs/). One directory per section,
> grouped by the page it belongs to, so a sample directory maps 1:1 to a
> section anchor on adk.dev.

Say what every directory exports, which is `rootAgent`, and how a sample fills
in the helpers the docs leave undefined.

### Running

The build-once, run-by-path pair, and what `npm run sample` expands to:

````markdown
```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/{category}/{sample_name}/agent.ts
```
````

Then the type-check command, `npm run ts:check:samples`, and why `samples/` is
checked separately: it is not an npm workspace, so `npm run build` does not
compile it, and it resolves `@google/adk` through `node_modules` rather than
through the root `paths` aliases.

### Coverage

State plainly whether CI executes the samples in this category.
`tests/integration/docs_samples/docs_samples_test.ts` resolves `SAMPLES_ROOT`
to `samples/workflows`, so only that category is constructed and run. For any
other category, say that lint, Prettier, the license check, and
`ts:check:samples` are the coverage, and that nothing runs the sample. A reader
deciding whether to trust a sample needs to know which of the two it is.

### Requirements

What a sample in this category needs beyond the repository: an API key, an
optional npm package, a corpus, a local service. Name the environment variables
and the exact install command. The per-sample header repeats the ones that
sample needs, and this section is where the reader finds the whole set.

### Samples

One table per group, or a single table for a flat category. Columns:

| Column         | Contents                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------- |
| `Sample`       | The directory name in backticks.                                                         |
| `Docs section` | A link to the adk.dev section, for a category that ports one. Omit the column otherwise. |
| `Shows`        | One line naming the one or two features the sample exists to demonstrate.                |
| `Key`          | `✅` when it calls a live model, `—` when it runs offline.                               |

Add a column when the category has a cost the `Key` column does not cover, such
as an optional package, rather than hiding it in prose.

### Worth knowing

Behaviour in this category that is easy to get wrong, each item also called out
in the affected sample's header comment. Write it as a bolded claim followed by
the reason, so a reader skimming the bold text still learns something:

> - **A second `output` event overwrites the first, silently.** A node may emit
>   any number of events carrying `output`; nothing throws, the last one wins,
>   and the successor never sees the rest.

Omit the section when the category has nothing surprising in it.

### See also

The guides under `docs/guides/` that explain the classes the category
exercises, and any larger set of examples elsewhere in the repository. Link by
relative path. From `samples/{category}/README.md` the repository root is two
levels up:

```markdown
- [Retrieval tools](../../docs/guides/tools/retrieval/index.md) - Choosing between client-side retrieval and Vertex AI RAG.
```

## Template

````markdown
# {Category} samples

What this category holds, and what one directory in it corresponds to. Each
directory exports a `rootAgent` that runs with the ADK CLI.

## Running

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/{category}/{sample_name}/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately:

```bash
npm run ts:check:samples
```

## Coverage

Which CI checks reach these samples, and whether anything executes them.

## Requirements

What these samples need beyond the repository, with the exact commands.

## Samples

| Sample   | Shows                         | Key |
| -------- | ----------------------------- | --- |
| `{name}` | One line on what it exercises | —   |

## Worth knowing

- **A claim worth remembering.** Why it is true and what goes wrong without it.

## See also

- [Guide Title](../../docs/guides/path/to/index.md) - Brief description of what the guide covers.
````
