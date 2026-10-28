# Computer use

`ComputerUseToolset` lets an agent operate a computer, such as a web browser,
through a computer use model. The model looks at screenshots and answers with
actions such as "click at (420, 310)" or "navigate to this url"; the toolset
runs them on a `BaseComputer` you provide and returns the new screenshot.

## Introduction

A computer use model does not call your function declarations. It calls a fixed
set of predefined actions that the `computerUse` tool enables in the request,
and it expects every function response to carry a screenshot of the result.
The three classes in `core/src/tools/computer_use/` split that work:

| Class                | Role                                                                                   |
| :------------------- | :------------------------------------------------------------------------------------- |
| `BaseComputer`       | The interface you implement: screen size, environment, and one method per action.      |
| `ComputerUseTool`    | Wraps one action. Scales coordinates, asks for safety confirmation, encodes the image. |
| `ComputerUseToolset` | Builds the tools for a computer and adds the computer use configuration to requests.   |

`BaseComputer` is abstract and imports no browser automation library, so the
same toolset works over Playwright, Puppeteer, a remote sandbox, or a fake in a
test. All three classes carry the `@experimental` decorator, and the feature can
be turned off with `ADK_DISABLE_COMPUTER_USE=true`.

## Get started

Implement `BaseComputer`, wrap it in a `ComputerUseToolset`, and give the
toolset to an `LlmAgent`:

```ts
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  LlmAgent,
} from '@google/adk';

class MyBrowserComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [1280, 720];
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  async clickAt(x: number, y: number): Promise<ComputerState> {
    // Click in the browser, then return a PNG screenshot and the url.
  }
  // ... the other abstract actions.
}

export const rootAgent = new LlmAgent({
  name: 'browser_agent',
  model: 'gemini-flash-latest',
  instruction: 'Operate the browser to complete the task.',
  tools: [new ComputerUseToolset({computer: new MyBrowserComputer()})],
});
```

The model must support the computer use tool. A complete, runnable version with
an in-memory computer is in `samples/tools/computer_use/`.

## How it works

### The computer

Every action method returns a `ComputerState`: the screenshot as PNG bytes in a
`Uint8Array`, and the current url. The coordinates a method receives are pixel
values in the space `screenSize()` describes.

| Method                                                    | Action the model calls                        |
| :-------------------------------------------------------- | :-------------------------------------------- |
| `openWebBrowser()`                                        | `open_web_browser`                            |
| `clickAt(x, y)`                                           | `click_at`, `click`                           |
| `hoverAt(x, y)`                                           | `hover_at`, `move`                            |
| `typeTextAt(x, y, text, pressEnter?, clearBeforeTyping?)` | `type_text_at`                                |
| `typeText(text, pressEnter?)`                             | `type`                                        |
| `scrollDocument(direction)`                               | `scroll_document`                             |
| `scrollAt(x, y, direction, magnitude)`                    | `scroll_at`, `scroll`                         |
| `wait(seconds)`                                           | `wait`, `wait_5_seconds`                      |
| `goBack()`, `goForward()`, `search()`                     | `go_back`, `go_forward`, `search`             |
| `navigate(url)`                                           | `navigate`                                    |
| `keyCombination(keys)`                                    | `key_combination`, `press_key`, `hotkey`      |
| `dragAndDrop(x, y, destinationX, destinationY)`           | `drag_and_drop`                               |
| `currentState()`                                          | `current_state`, `take_screenshot`            |
| `doubleClick`, `rightClick`, `keyDown`, ... (optional)    | `double_click`, `right_click`, `key_down`, .. |

Three methods have defaults you can override:

- `initialize()` and `close()` do nothing. The toolset calls `initialize()`
  before the first action and `close()` when the toolset closes.
- `prepare(toolContext)` does nothing. The toolset calls it before every
  action, so a computer shared between sessions can bind the session's sandbox
  or credentials from `toolContext.state`.
- `typeText(text, pressEnter)` presses each character with `keyCombination`.
  Override it with native bulk text input; the default costs one round trip and
  one screenshot per character.

The optional Gemini 3.x actions (`doubleClick`, `tripleClick`, `middleClick`,
`rightClick`, `mouseDown`, `mouseUp`, `keyDown`, `keyUp`) are offered to the
model only when your subclass implements them.

The Gemini 3.x actions `click`, `move`, `type`, `scroll`, `take_screenshot`,
`press_key` and `hotkey` are always offered. To handle one natively, define the
optional method of the same name on your subclass:

| Optional method                               | Replaces for its action |
| :-------------------------------------------- | :---------------------- |
| `click(x, y, button?)`                        | `clickAt`               |
| `move(x, y)`                                  | `hoverAt`               |
| `type(text, pressEnter?)`                     | `typeText`              |
| `scroll(x, y, direction, magnitudeInPixels?)` | `scrollAt`              |
| `takeScreenshot()`                            | `currentState`          |
| `pressKey(key)`                               | `keyCombination`        |
| `hotkey(keys)`                                | `keyCombination`        |

An optional argument is `undefined` when the model leaves it out, so your
method's own default applies. With a native `click`, the model's `button` is
passed through; without one, `click` calls `clickAt` and ignores `button`.

### The tool

`ComputerUseTool` is a `FunctionTool` that adds three behaviors:

- **Coordinates.** The model works in a 1000x1000 grid. The tool scales `x`,
  `y`, `destination_x`, `destination_y`, `start_x`, `start_y`, `end_x` and
  `end_y` to the screen size and clamps them to the screen. Set
  `virtualScreenSize` to change the grid.
- **Safety decisions.** When the model marks a call with a `safety_decision` of
  `require_confirmation`, the tool asks the user to confirm before it runs, the
  same way `requireConfirmation` does on a `FunctionTool`. Once confirmed, the
  response carries `safety_acknowledgement: 'true'`.
- **Screenshots.** A `ComputerState` result becomes
  `{image: {mimetype: 'image/png', data}, url}`. The agent moves the image into
  the function response's `parts`, so the model receives it as an image.

### The toolset

`ComputerUseToolset` initializes the computer on first use and builds one
`ComputerUseTool` per action. Actions on one computer run one at a time, even
when the model returns several in one response.

When the agent builds a request, the toolset registers its tools and adds one
`{computerUse: {environment, excludedPredefinedFunctions}}` tool. The
`excludedPredefinedFunctions` names follow the model: Gemini 1.x and 2.x models
get the legacy names, and every other model gets the Gemini 3.x names, plus the
optional actions the computer does not implement on Gemini 3.x models.

```ts
new ComputerUseToolset({
  computer,
  // Legacy and Gemini 3.x names are both accepted. Excluding click_at also
  // hides click.
  excludedPredefinedFunctions: ['click_at', 'drag_and_drop'],
  // Let navigate reach localhost and internal hosts.
  allowPrivateNetworkAccess: true,
});
```

### The model

When a request carries a computer use configuration, `Gemini` drops the system
instruction, which the computer use model does not accept, and registers a
`wait_5_seconds` tool next to `wait`. With the Interactions API, the
configuration becomes a `{type: 'computer_use'}` tool.

To change a predefined action before the request is sent, call
`adaptComputerUseTool({methodName, adapter, llmRequest})`, for example from a
`beforeModelCallback`. The adapter receives the original function and returns
a new `{name, description, execute}`; the new tool keeps the original screen
size, and replaces the original when its name differs.

## Security

`navigate` checks every url the model supplies before it reaches the computer.
It refuses a url that is not http(s), or whose host is `localhost`, a
`.local`, `.internal` or `.localhost` name, a metadata host, or an address that
is not publicly routable. In Node.js, hostnames are resolved and every address
they resolve to is checked; a browser cannot resolve hostnames, so there only
the name and IP literals are checked. A refused call returns an error and the
current url, and the computer never navigates.

These checks are not a sandbox. The browser resolves the name again when it
connects, which leaves a DNS-rebinding window, and pages can still link to
other hosts. Run an untrusted browsing task in an isolated environment.
