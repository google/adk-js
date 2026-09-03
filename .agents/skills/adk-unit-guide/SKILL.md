---
name: adk-unit-guide
description: >-
  Writes a hands-on developer guide for one ADK TypeScript code unit — a minimal
  runnable example, how it works, a configuration-option table, advanced uses,
  limitations, and links to related samples — to
  `docs/guides/{topic}/{unit}/index.md`, then lists it in the index at
  `docs/guides/README.md`. Its reader is a developer calling the unit from their
  own application, at more depth than the published adk.dev documentation
  carries. Use when asked to "write a unit guide for {class}", "document how to
  use {feature}", "add a guide for {file}", or after shipping a user-facing
  class, node, tool, or plugin. Don't use for internals documentation aimed at
  someone changing or extending the unit. Don't use to write a runnable sample
  under `samples/` (use `adk-sample-creator`).
---

# ADK code unit guide

A unit guide is granular usage documentation for one code unit, deeper than what
ships on adk.dev — so detail that would bloat the published documentation has
somewhere to live. The reader wants to call the unit from an application, so
lead with working code.

Unit guides focus on public APIs and caller-visible behavior. Do not
discuss internal implementation details (such as private methods, internal state
mechanisms, or unexported helpers).

`docs/guides/` is new in adk-js. Until it fills out, expect to create the
category heading in the index as well as the guide.

## Voice

Write to help the reader understand, not to instruct them from above.

- **Give the reason, not only the rule.** Whenever the guide states a
  constraint, a default, or a recommendation, say why it is that way. A reader
  who knows the reason can handle the case the guide did not anticipate.
- **Do not decide for the reader.** Phrasings such as "most applications never
  need this" or "you will rarely" tell people what they want. State the
  trade-off and let them choose.
- **Explain at the caller's level.** Explaining what happens is required;
  explaining the machinery that makes it happen is not. If an explanation needs
  a private symbol to make sense, it is pitched at the wrong layer.
- **Length follows understanding.** Brevity is not the goal. Where a reader
  would have a follow-up question, answer it. Where the sentence already lands,
  leave it.
- **Problem before syntax.** Say what the reader is trying to do, then show the
  code.
- Every heading has at least one sentence under it before the next heading, and
  every code block has a sentence introducing what it does.

Sentence-level rules, following the Google developer documentation style guide:
present tense, no contractions, no parentheticals (use commas), no bare "This"
as a subject, no `e.g.` or `etc.`, no superlatives, sentence case in headings,
and no heading deeper than H3.

### What the difference looks like

Both pairs below are quoted from adk-python guides, because adk-js has no older
guide to quote. The failure each one shows is language-independent.

From the `BaseNode` guide. Before:

> Most applications never subclass `BaseNode`, so the sections that follow cover
> the settings first.

That decides for the reader and gives them nothing to check their own case
against. After:

> You usually configure a node rather than subclass one, because the settings
> below cover what most graphs need. Subclassing earns its keep when you want
> behavior the settings cannot express, and that case is at the end.

Same length, same facts. The second one names the reason, so a reader can tell
which of the two situations is theirs.

A second pair, from the `JoinNode` guide. Before:

> Here three tasks run in parallel on the same input, and a `JoinNode` collects
> their results.

That opens in speech rather than documentation, and it drops the name of the
pattern the reader would search for. After:

> This example builds a fan-out/fan-in workflow. Three tasks run in parallel on
> the same input, and a `JoinNode` aggregates their results so that a final node
> can present all three together.

## Inputs

Require the source file, or a class, function, or interface named inside it.
Also read its unit tests under `core/test/` when they exist, because they give
you an example to adapt and they pin the behavior the guide is allowed to claim.

## Analyse before writing

- Purpose and intended use of the unit.
- Which classes depend on it, and which it depends on.
- Configuration options the unit itself introduces, ignoring inherited ones.
  In adk-js an option is usually a field on the unit's `…Params` or `…Config`
  interface, so read that interface rather than the constructor body.
- Whether the unit is exported from `core/src/index.ts` or `core/src/common.ts`.
  A unit the reader cannot import from `@google/adk` is not ready for a guide;
  say so instead of documenting a deep import path.
- Known limitations.
- Exclude internal implementation details such as private fields, unexported
  helper functions, and internal data structures.

## Where the guide goes

Mirror the source path under `docs/guides/`, dropping the `core/src/` prefix and
the `.ts` extension. One source file is one unit, one unit is one directory, and
the guide is that directory's `index.md`:

| Source                                              | Guide                                                        |
| :-------------------------------------------------- | :----------------------------------------------------------- |
| `core/src/tools/mcp/mcp_toolset.ts`                 | `docs/guides/tools/mcp/mcp_toolset/index.md`                 |
| `core/src/plugins/reflect_retry_tool_plugin.ts`     | `docs/guides/plugins/reflect_retry_tool_plugin/index.md`     |
| `core/src/tools/retrieval/base_retrieval_tool.ts`   | `docs/guides/tools/retrieval/base_retrieval_tool/index.md`   |
| `core/src/tools/retrieval/llama_index_retrieval.ts` | `docs/guides/tools/retrieval/llama_index_retrieval/index.md` |
| `core/src/tools/retrieval/files_retrieval.ts`       | `docs/guides/tools/retrieval/files_retrieval/index.md`       |

The rule does not bend for a directory that holds a base class and the
implementations that subclass it, which is the last three rows. Each file is
still a unit and still gets its own guide. A reader looking up `FilesRetrieval`
has a page named after the class they are holding, and the guide for a class
they are not using does not grow to cover them.

Use named files instead of `index.md` only when one source file has genuinely
separate usage modes.

Update an existing guide in place, keeping the existing wording wherever the
code has not changed, so the diff shows only what the change actually altered.

Then add the guide to `docs/guides/README.md` under the right category heading,
as `* [Title](path/index.md) - one-line summary.` That index is the only table
of contents; a guide missing from it is unreachable.

### Guides for a set of siblings

Splitting a base class and its implementations across guides costs the reader
something real, and the split does not pay for itself unless you buy it back. A
reader arrives at one page from search, not at the set, so they need to be able
to tell from the first paragraph whether they are on the right page — and if
they are not, which sibling is. Two things carry the set:

- **Each guide opens by naming its siblings**, one line each, giving the reason
  to pick that one rather than a description of what it is. Put this before the
  guide explains its own class, because it is what tells the reader to keep
  reading or to leave. Link siblings by relative path from one guide directory
  to the next: `[FilesRetrieval](../files_retrieval/index.md)`.
- **`docs/guides/README.md` lists the set under one shared heading**, with a
  sentence above the list saying what the set is for. A reader scanning the
  index sees a family and its entry point, rather than three entries that look
  unrelated because they sort apart.

Put a comparison that decides between the siblings, or between the family and
something outside it, in the guide for the class where that decision is made —
usually the base class, since that is where a reader lands before they have
chosen an implementation. The other guides link to it rather than repeat it.

## Code examples

- One minimal example under "Get started", with enough of the surrounding
  classes to show where the call belongs. Start from a unit test if one exists.
- Keep the `import {…} from '@google/adk'` line, because the import is the
  single most error-prone thing a reader copies, and the reader imports from the
  package, never from `core/src/…`. Omit unrelated Node built-in imports and
  runner boilerplate, which add nothing about the unit.
- Guide code is a consumer of the published package. Relative imports inside
  the repository carry a `.js` extension under `nodenext` resolution; a guide
  example rarely has one, and it must not put `.js` on `@google/adk`.
- Show what a developer would actually write. An example that only demonstrates
  the shape of an interface, or that drives a service the reader would normally
  reach through `Runner`, does not belong in a guide.
- Set `model: 'gemini-flash-latest'` on an `LlmAgent`. There is no
  system-configured default in adk-js — `canonicalModel` throws
  `No model found for {name}` when neither the agent nor an ancestor sets one —
  so a model-free example does not run. The floating `-latest` alias is what
  every sample in the repository uses, and it answers the same concern a pinned
  `gemini-2.5-flash` would raise, because the alias moves when the model behind
  it is retired.
- Names follow the repository split: `camelCase` for variables, functions, and
  interface fields; `PascalCase` for classes and types; `snake_case` only inside
  the string passed as an agent's or a node's `name`, which is the identifier
  the model and the CLI see.
- For workflow nodes, show the logic as a plain function passed to
  `node(fn, {name})` rather than a `BaseNode` subclass, unless the use case
  genuinely requires the subclass. Reach for `new FunctionNode(...)` only when
  demonstrating `FunctionNode` configuration itself.
- Verify every example against the real signatures before shipping it. Type the
  snippet into a scratch file under `samples/` and run
  `npm run ts:check:samples`, or copy it into a test file and run
  `npm run ts:check`. A guide example that does not compile is worse than no
  example, because the reader assumes the mistake is theirs.

## Link related samples

Link samples by repo-relative path from the guide, not by GitHub URL. Count the
`../` from the guide's own directory rather than reusing a depth from another
guide, because a guide that mirrors a nested source directory sits deeper. From
`docs/guides/{topic}/{unit}/index.md` the repository root is four levels up, and
from `docs/guides/tools/retrieval/files_retrieval/index.md` it is five:
`[Retrieval tools](../../../../../samples/tools/retrieval/agent.ts)`. Confirm
the file exists before linking it.

## Structure

Follow [references/guide-template.md](references/guide-template.md) section by
section.

## Dropped from the adk-python skill

adk-python pairs each guide with a design document at
`docs/design/{topic}/{unit}/index.md` and lists it as an input. adk-js has no
`docs/design/` tree and no design-document skill, so that input is dropped
rather than replaced with an invented location.
