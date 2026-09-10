# ADK Integrations

Third-party model and service integrations for the Google ADK, kept out of
`@google/adk` so that core carries no vendor SDK it does not need.

```bash
npm install @google/adk @google/adk-integrations
```

## Claude (Anthropic)

Two model classes, one per service Claude is offered on.

### The Anthropic API

`AnthropicLlm` is registered for `claude-*`, so importing this package is enough
to name a Claude model as a string:

```ts
import {LlmAgent} from '@google/adk';
import '@google/adk-integrations';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'claude-sonnet-4-5-20250929',
  instruction: 'You are a helpful assistant.',
});
```

The API key comes from `ANTHROPIC_API_KEY`. Construct the model instead to set
it explicitly, or to change anything else:

```ts
import {AnthropicLlm} from '@google/adk-integrations';

const model = new AnthropicLlm({
  model: 'claude-sonnet-4-5-20250929',
  apiKey: process.env.MY_KEY,
  maxTokens: 4096, // Used when the request sets no maxOutputTokens.
  baseURL: 'https://my-proxy.example/v1',
});
```

Pass `client` to hand over a pre-configured Anthropic client — a custom retry
policy, a browser client built with `dangerouslyAllowBrowser`, or Bedrock via
`@anthropic-ai/bedrock-sdk`.

### Vertex AI Model Garden

`Claude` calls the copy served from Google Cloud: authentication and quota come
from your project, so there is no Anthropic key. It needs the optional peer
dependency `@anthropic-ai/vertex-sdk`, and a project and region — from the
constructor, from `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`, or from a
fully qualified model name.

```bash
npm install @anthropic-ai/vertex-sdk
```

```ts
import {Claude} from '@google/adk-integrations';

// Vertex spells the version with an `@` where the Anthropic API uses a dash.
const model = new Claude({model: 'claude-sonnet-4-5@20250929'});
```

Only the fully qualified resource name resolves to `Claude` through the
registry, because a bare `claude-*` name is ambiguous between the two services
and goes to the Anthropic API:

```ts
const model =
  'projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-1';
```

### What is supported

Text, function calling, images and PDFs on input, extended thinking, prompt
caching token accounting, and server-side streaming (`StreamingMode.SSE`).

ADK's `thinkingConfig.thinkingBudget` maps onto Claude's thinking modes: `0`
disables thinking, `-1` lets the model choose its own depth, and a positive
value is a manual token budget. Anthropic accepts no default, so a
`thinkingConfig` carrying no budget is rejected rather than guessed at.

Claude has no bidirectional streaming endpoint, so `runLive` / `connect()`
throws. A part Claude has no equivalent for is dropped with a warning rather
than failing the turn, because the part stays in the session history and failing
would wedge every later turn too.

### Samples

Runnable agents live in [`samples/claude/`](../samples/claude), covering the
basics, function calling, extended thinking and Vertex AI.
