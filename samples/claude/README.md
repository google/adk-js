# Claude samples

Runnable agents backed by Anthropic's Claude models, through
`@google/adk-integrations`. One directory per capability.

| Sample                                            | What it shows                                                |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [`get_started`](get_started/agent.ts)             | The smallest Claude agent: a bare `claude-*` model name      |
| [`tools`](tools/agent.ts)                         | Function calling, and constructing the model to configure it |
| [`extended_thinking`](extended_thinking/agent.ts) | Mapping `thinkingBudget` onto Claude's thinking modes        |
| [`vertex`](vertex/agent.ts)                       | The same models served from Vertex AI Model Garden           |

## Running

```bash
npm run build            # builds @google/adk, @google/adk-integrations and the CLI
export ANTHROPIC_API_KEY=sk-ant-...
npm run sample -- samples/claude/get_started/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`. The CLI is interactive: type a
message and press Enter, or `exit` to quit. Pipe a single message to run
non-interactively:

```bash
echo "What is 2 + 3?" | npm run sample -- samples/claude/get_started/agent.ts
```

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
is type-checked separately, against the published types:

```bash
npm run ts:check:samples
```

## Choosing a model

Two classes, one per service:

- **`AnthropicLlm`** calls the Anthropic API with an `ANTHROPIC_API_KEY`.
  Registered for `claude-*`, so a bare model name resolves to it.
- **`Claude`** calls the copy served from Vertex AI Model Garden with Google
  Cloud credentials. Registered only for the fully qualified resource name
  `projects/<p>/locations/<l>/publishers/anthropic/models/<id>`, because a bare
  name is ambiguous between the two services. Construct it directly to use a
  short name.

Importing `@google/adk-integrations` anywhere registers both, which is why
[`get_started`](get_started/agent.ts) imports it for its side effect alone.

## API keys

An Anthropic key comes from the [Anthropic Console](https://console.anthropic.com/).
Export it, or put it in a `.env` at the repo root:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The Vertex sample needs no Anthropic key. It authenticates with Application
Default Credentials (`gcloud auth application-default login`) and reads
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`; the model also has to be
enabled in Model Garden for that project and region. It additionally needs the
optional peer dependency:

```bash
npm install @anthropic-ai/vertex-sdk
```

## Limits

- **No live API.** Claude has no bidirectional streaming endpoint, so
  `runLive` / `connect()` throws. Server-side streaming (`StreamingMode.SSE`)
  works: text and thinking arrive as partial responses, tool arguments only in
  the final one, since they are streamed as JSON fragments that parse only once
  complete.
- **Media is input-only.** Images (`image/gif`, `image/jpeg`, `image/png`,
  `image/webp`) and PDFs are sent on user turns; Claude returns text, tool calls
  and reasoning, never media.
- **A part Claude has no equivalent for is dropped with a warning,** rather than
  failing the turn — the part stays in the session history, so failing would
  wedge every later turn too.
