# Unit guide template

Copy this structure into `docs/guides/{topic}/{unit}/index.md`. The bullets are
instructions for what to write in each section, not text to keep.

````markdown
# {unit_name}

Two-sentence summary of the code unit.

## Introduction

Prose covering the purpose and application of the unit, the key classes that
depend on it, and the developer problems it solves.

## Get started

A single minimal implementation demonstrating the unit, with enough of the
surrounding classes to show where the call belongs. Keep the `@google/adk`
import line and omit runner boilerplate to keep the code snippet focused.

```ts
import {SomeUnit} from '@google/adk';
```

## How it works

How the unit accomplishes its purpose from a caller's perspective, the classes
it depends on, the classes that depend on it, and the cross-class interactions a
caller will notice. Do not discuss internal implementation details (such as
private fields, internal data structures, or unexported helpers).

## Configuration options

A table of the options the unit itself introduces, which in adk-js is usually
the unit's `…Params` or `…Config` interface:

| Option     | Type     | Default     | Description       |
| :--------- | :------- | :---------- | :---------------- |
| `{option}` | `{type}` | `{default}` | What it controls. |

Follow the table with a paragraph per option covering real behaviour and usage
patterns, not a restatement of the type. Omit options inherited from a base
class, never include private fields, and do not enumerate every field and
method — exhaustive API reference belongs in the generated TypeDoc reference.

## Advanced applications

Use cases beyond the minimum: the problem each solves and the implementation
for that circumstance. Omit the section when there are none.

## Limitations

Known limits of the unit. An optional peer dependency the unit needs at
runtime belongs here, because a reader cannot discover it from the type
signatures.

## Related samples

Links to samples under `samples/` that exercise the unit, each with a one-line
description. Paths are relative, and the repository root is four levels up
from the guide.
````

Omit a section outright when the code gives you nothing to put in it.
