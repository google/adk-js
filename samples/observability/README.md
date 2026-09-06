# Observability samples

Runnable TypeScript examples that route ADK's telemetry to a third-party
observability backend.

ADK instruments the framework with OpenTelemetry: every model call becomes a
`gen_ai.*` span, and `maybeSetOtelProviders` lets you attach your own span
processors without replacing ADK's tracing.
These samples use that hook to forward spans to an external product.

One directory per backend.

## PostHog (`posthog/`)

Sends ADK's `gen_ai.*` spans to [PostHog](https://posthog.com), which converts
them into `$ai_generation` events server-side and surfaces them in its
[LLM analytics](https://posthog.com/docs/ai-engineering/observability) product -
model, token usage, latency, and, when span content capture is on, the prompt
and response.

### Wiring (recommended: the published `@posthog/ai/otel`)

In your own project, install PostHog's AI SDK and hand its span processor to
ADK. That is the whole integration:

```bash
npm install @posthog/ai
```

```ts
import {maybeSetOtelProviders} from '@google/adk';
import {PostHogSpanProcessor} from '@posthog/ai/otel';

maybeSetOtelProviders([
  {
    spanProcessors: [
      new PostHogSpanProcessor({
        projectToken: process.env.POSTHOG_API_KEY!,
        host: process.env.POSTHOG_HOST, // defaults to https://us.i.posthog.com
      }),
    ],
  },
]);
```

`PostHogSpanProcessor` keeps only AI spans, batches them, and exports them to
PostHog's OTLP ingestion endpoint (`/i/v0/ai/otel`). It self-disables on a blank
token, so leaving `POSTHOG_API_KEY` unset simply runs the agent without
telemetry.

The runnable sample in `posthog/agent.ts` inlines an equivalent processor
instead of importing `@posthog/ai`, so this monorepo does not take on a new
dependency (`@posthog/ai` optionally peer-depends on an older `@google/genai`
than ADK uses). The inlined version uses only the OpenTelemetry packages ADK
already depends on - the same OTLP path `@posthog/ai/otel` takes. In your own
project, prefer the published class above.

### Running the sample

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
export GEMINI_API_KEY=...
export POSTHOG_API_KEY=phc_...
export POSTHOG_HOST=https://us.i.posthog.com   # optional; this is the default
npm run sample -- samples/observability/posthog/agent.ts
```

Get the **project API key** (`phc_...`) from PostHog under
_Settings -> Project -> API keys_, and use `https://us.i.posthog.com` (US cloud)
or `https://eu.i.posthog.com` (EU cloud) as the host.

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`. The CLI is interactive: type a
message and press Enter; type `exit` to quit.

### What shows up in PostHog

Ask the agent a question, then open **LLM analytics** in PostHog. Within a few
seconds the model call appears as an `$ai_generation` event carrying the model
name (`gemini-flash-latest`), input/output token counts, latency, and the
finish reason. Multiple turns in one session share a trace, so you can follow a
conversation end to end.

By default ADK also records prompt and response content on the spans. To keep
message bodies out of your spans, set
`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` before running; the events still
carry model and usage metadata.
