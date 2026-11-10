# Computer use

## Overview

`ComputerUseToolset` exposes a `BaseComputer` to an agent as the predefined
actions that a computer use model calls, such as `click_at`, `type_text_at` and
`navigate`, together with their Gemini 3.x names, such as `click` and `type`.
This sample gives `browser_agent` the toolset over `InMemoryBrowserComputer`.

`InMemoryBrowserComputer` is a stand-in for a real computer. It keeps a browsing
history in memory and answers every action with the same blank 1x1 screenshot,
so the sample needs no browser automation library. Replace it with a subclass
of `BaseComputer` that drives a real browser or a remote sandbox.

## Requirements

- `GEMINI_API_KEY`, for the model. A `.env` file in the working directory is
  loaded automatically.
- A model that supports the computer use tool. Change `model` in `agent.ts` if
  the default does not.

## Running

Build once, then run the sample:

```bash
npm run build
npm run sample -- samples/tools/computer_use/agent.ts
```

To type-check the sample against the built package:

```bash
npm run ts:check:samples
```

## Sample Inputs

- `open example.com and go back`
- `search for the weather`

## Worth knowing

- **The model works in a 1000x1000 grid.** `ComputerUseTool` scales every
  coordinate to the size that `screenSize()` returns before it calls the
  computer, so a `BaseComputer` always receives pixel coordinates.
- **`navigate` refuses private hosts.** A url that is not http(s), or whose
  host is loopback, private, link-local or internal, never reaches the
  computer. Set `allowPrivateNetworkAccess: true` on the toolset to drive a
  local development server.

See the [computer use guide](../../../docs/guides/tools/computer_use/index.md)
for the full API.
