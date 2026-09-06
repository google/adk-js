# ADK TypeScript ↔ Python parity harness

Runs the **same scenario** through `adk run` in both runtimes and diffs what
happened. The test cases are the adk-python
[`contributing/samples`](https://github.com/google/adk-python/tree/main/contributing/samples).

The output is `PARITY_REPORT.md`, written next to this file by a run. It is
deliberately **not** committed: it is a snapshot of one run against one pair of
versions, so a checked-in copy is stale the moment either side moves.

## Why it is built this way

**Both CLIs already speak the same two dialects.** `adk run --replay <file>`
takes `{"state": {...}, "queries": [...]}` in both runtimes, and
`--save_session` dumps the resulting `Session` as JSON with the same camelCase
shape. So the harness drives the real CLIs and compares _structured events_,
never scraped stdout.

**Wording is never a failure.** The model is free to phrase an answer
differently on two calls, let alone two SDKs. What must agree is everything the
_framework_ decides:

| Compared, fails the suite (`structural`)            | Compared, reported only (`cosmetic` / `infrastructure`) | Not compared               |
| --------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| tool call sequence and argument names               | event count / how text is split across events           | answer wording             |
| which agents produced events                        | same agents or tools in a different order               | timestamps, ids            |
| agent transfer chain                                | whether thought parts are surfaced                      | `modelVersion`, `nodeInfo` |
| session state keys and values                       | a transient model/API failure on one side               | token usage                |
| artifacts written, escalation, long-running signals |                                                         |                            |

Final answers are put side by side in the report with a token-overlap score so
a human can spot answers that differ in _substance_, without that ever failing
the run.

**The model is pinned on both sides.** The two runtimes ship different
defaults, so a sample that omits `model=` would compare two different models
and blame the framework. `ADK_PARITY_MODEL` (default `gemini-2.5-flash`) is
injected into both.

**One run of an LLM-backed case proves nothing.** Measured across two full runs
of this suite, with neither framework changing, **18% of cases changed
verdict**. So each case is compared `--repeats` times (default 3) and a
difference is reported only if a _majority_ of repeats saw it. Anything seen
but not carried is listed under "Reproducibility" in the report as noise, which
keeps it visible without letting it count. `--repeats 1` is fast, and the
report says in bold that its results are leads rather than findings.

**A failed model call is not a parity result.** A 429, a 503, a timeout or an
empty completion is classified `infrastructure`: the repeat is retried
(`--retries`, default 1) and never scored. The one exception is deliberate — a
_deterministic_ 4xx that only one runtime provokes stays a structural finding,
because that is exactly the interesting case (adk-python inlining an
`image/bmp` artifact Vertex rejects, or combining `output_schema` with function
calling).

## Setup

```bash
./setup.sh                 # clones adk-python at a pinned ref, builds a venv
npm run build              # from the repo root, for the TS CLI
```

Needs credentials for a Gemini backend: either `GOOGLE_CLOUD_PROJECT` (Vertex,
via ADC) or `GOOGLE_API_KEY` / `GEMINI_API_KEY`.

## Running

```bash
npm run test:parity                       # everything, writes PARITY_REPORT.md
npm run test:parity -- --filter workflows # one family, or one case id
npm run test:parity -- --jobs 6           # more concurrency
npm run test:parity -- --repeats 5        # more confidence (default 3)

npm run ts:check:parity                   # type-check this tree
node --experimental-strip-types tests/cross_language/python_parity/harness/load_check.ts
```

`load_check` loads every ported agent through both runtimes' real loaders and
makes **no model calls**. It is the fast feedback loop while writing a port,
and it separates "this port is broken" from "these runtimes genuinely differ".

Under vitest (`npm run test:cross-language`) the catalogue checks and
`load_check` always run; the live comparison needs `ADK_PARITY_LIVE=1`.

## Layout

```
setup.sh              provisions adk-python + venv (both gitignored)
cases.ts              the catalogue, concatenated from cases/
cases/<family>.ts     one file per sample family
agents/ts/<family>/   TS ports of the Python samples
agents/py/<case_id>/  three-line shims that import the real upstream sample
agents/py/_parity.py  the shim helper: imports a sample, pins its model
harness/              runner, normalizer, comparator, report
runs/<case_id>/       per-case replay, both session dumps, stdout, diff.json
```

## Adding a case

1. **TS port** — `agents/ts/<family>/<name>.ts`, exporting `rootAgent` or
   `app`. Keep tool names, parameter names, agent names, descriptions and
   instruction text _identical_ to the Python sample; any behavioural
   difference should come from the framework, not your wording. Take the model
   from `../model.ts`.
2. **Python shim** — `agents/py/<case_id>/agent.py`:
   ```python
   from _parity import load_sample
   root_agent = load_sample('core/hello_world')
   ```
   The vendored checkout is never edited: the shim imports the real sample and
   pins its model, so `git -C adk-python status` stays clean.
3. **Case entry** — append to `cases/<family>.ts`. See `ParityCase` in
   `harness/types.ts`. Source `queries` from the sample's own `main.py`,
   `README.md` or `tests/*.json` rather than inventing them.

Imports in this tree use explicit `.ts` extensions, because the harness runs
under Node's `--experimental-strip-types`, which resolves the file on disk and
will not rewrite a `.js` specifier onto a `.ts` file. Hence the local
`tsconfig.json` and the exclusion from the root one.

### If adk-js cannot express the sample

Do not fake it and do not write a half-port. Give the case no `tsAgent` and a
skip reason with a **specific** note:

```ts
{
  id: 'core_logprobs', family: 'core', pySample: 'core/logprobs',
  queries: ['...'],
  skip: 'unsupported-in-ts',
  note: 'adk-js LlmResponse has no avgLogprobs/logprobsResult; ...',
}
```

Those notes are the capability-gap section of the report, and are the most
useful thing the harness produces.

## Scripted pauses

There is no interactive prompt in a replay run, so **the answer to a pause is
the next query** in `queries`. Several upstream samples ship exactly that as
`tests/*.json`; reuse them verbatim. Note that the two CLIs do not resolve
pauses the same way — see the HITL findings in the report.
