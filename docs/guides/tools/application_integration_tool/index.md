# ApplicationIntegrationToolset

`ApplicationIntegrationToolset` gives an agent tools for a Google Cloud
Application Integration API trigger, or for the entities and actions of an
Integration Connectors connection. It gets or builds an OpenAPI spec for the
resource and turns each operation in it into a `RestApiTool`.

## Introduction

Application Integration and Integration Connectors already describe what a
resource can do. An integration with an API trigger can produce an OpenAPI
spec for that trigger, and a connection can report the schema of each entity
and action it exposes. `ApplicationIntegrationToolset` reads that description
and hands it to [`OpenAPIToolset`](../openapi_tool/index.md), so an agent can
call the resource without you writing a spec or a tool by hand.

The toolset has two modes:

- **Integration mode** asks Application Integration for the spec of one API
  trigger. The agent gets one tool per operation in that spec.
- **Connection mode** reads the schemas of the entities and actions you name
  and builds the spec itself. Every operation runs through an integration
  named `ExecuteConnection`, which executes it on the connection.

Two lower-level classes do the work, and both are exported for callers who
want the spec rather than the tools. `IntegrationClient` returns the spec for
either mode, and `ConnectionsClient` reads connection details and schemas.

All three classes are marked experimental, so each logs a warning the first
time one is constructed. They are exported from the Node entry point of
`@google/adk` and not from the browser entry point, because they depend on
`google-auth-library`.

## Get started

This example gives an agent the list and get operations of the `Issues`
entity and the custom query action of a connection. The toolset goes into
`tools` like any other toolset.

```ts
import {ApplicationIntegrationToolset, LlmAgent} from '@google/adk';

const issueTracker = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'my-issue-tracker',
  entityOperations: {Issues: ['LIST', 'GET']},
  actions: ['ExecuteCustomQuery'],
  toolName: 'tracker',
});

export const rootAgent = new LlmAgent({
  name: 'issue_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions about issues with the tools you have.',
  tools: [issueTracker],
});
```

The agent sees `tracker_list_issues`, `tracker_get_issues`, and one tool for
the custom query, named after the display name Integration Connectors reports
for the action.

For integration mode, name the integration and its API trigger instead of a
connection:

```ts
const orders = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  integration: 'process-orders',
  trigger: 'api_trigger/process-orders',
});
```

## How it works

The constructor only validates the options. It throws
`Either (integration and trigger) or (connection and (entityOperations or actions)) should be provided.`
unless you set both `integration` and `trigger`, or set `connection` together
with a non-empty `entityOperations` or `actions`. An empty object and an empty
array count as not set. When both modes are configured, integration mode
wins.

The network calls happen on the first `getTools` call, which the agent makes
at the start of its first turn. That call does the following:

1. In integration mode, it asks Application Integration to generate the
   OpenAPI spec of the trigger.
2. In connection mode, it reads the service name and host of the connection,
   then reads the schema of every entity and action you named. It builds a
   spec with one operation per entity operation and per action.
3. It passes the spec to `OpenAPIToolset`, together with one credential, and
   returns the tools that come back. Connection-mode paths share one URL and
   differ only by a fragment, such as `#list_Issues`. The toolset removes the
   fragment from each path first, so the request carries only
   `triggerId=api_trigger/ExecuteConnection`.

Later calls return the same tool objects without another request. Concurrent
calls share one load. When the load fails, `getTools` rejects, and the next
call tries again from the start, so a transient failure does not disable the
toolset for the life of the process.

The loading errors carry fixed messages. A response with HTTP 400 or 404
gives `Invalid request. Please check the provided values of …`, naming the
values the request used. Any other failed response, or a request that does
not reach the server, gives `Request error: …`. Anything else, such as
credentials that cannot produce a token, gives
`An unexpected error occurred: …`.

### Connection mode in detail

For each entity, the toolset reads the entity's JSON schema and the
operations it supports. An empty operation list, such as `{Projects: []}`,
selects every supported operation. Each operation becomes one tool:

| Operation | Tool name, before the parser normalizes it | What the tool does             |
| :-------- | :----------------------------------------- | :----------------------------- |
| `LIST`    | `{toolName}_list_{entity}`                 | Lists records, with paging     |
| `GET`     | `{toolName}_get_{entity}`                  | Reads one record by `entityId` |
| `CREATE`  | `{toolName}_create_{entity}`               | Creates a record               |
| `UPDATE`  | `{toolName}_update_{entity}`               | Updates a record by `entityId` |
| `DELETE`  | `{toolName}_delete_{entity}`               | Deletes a record by `entityId` |

The operation names are not case sensitive. Any other name rejects the load
with `Invalid operation: {operation} for entity: {entity}`.

Each action becomes one tool named `{toolName}_{displayName}`, where
`displayName` is the display name Integration Connectors reports. The
`ExecuteCustomQuery` action is different from the others: its tool takes a
SQL `query`, a `timeout` and a `pageSize` rather than an input payload, and
its description tells the model to convert a question in natural language
into SQL.

`OpenAPIToolset` turns each name into snake case and cuts it at 60
characters, so `tracker_list_Issues` reaches the model as
`tracker_list_issues`. With the default empty `toolName`, the name is
`list_issues`.

Every tool description tells the model which entity or action and which
operation to send, so the model does not ask the user for them. The toolset
also adds the service name, the host and the full connection name to the end
of `toolInstructions`, because every request must carry them and the user has
no reason to know them.

The entity schema reaches the model in two places. The list and get tools
quote it in their response description, and the create and update tools take
a payload whose schema comes from it. The conversion keeps `type`,
`description`, `properties` and `items`, and turns a type list that holds
`null` into `nullable: true`. It drops every other keyword, such as
`required`, `enum` or `format`.

### Credentials

One credential serves two purposes. It authenticates the requests that fetch
the spec and the schemas, and `OpenAPIToolset` puts it on every generated
tool, paired with a bearer scheme.

- With `serviceAccountJson`, both use that service account with the
  `https://www.googleapis.com/auth/cloud-platform` scope.
- Without it, both use Application Default Credentials with the same scope.
  When those are not available, the load rejects with
  `An unexpected error occurred: Please provide a service account that has the required permissions to access the connection.`

## Configuration options

The options are the fields of `ApplicationIntegrationToolsetOptions`.

| Option               | Type                       | Default  | Description                                               |
| :------------------- | :------------------------- | :------- | :-------------------------------------------------------- |
| `project`            | `string`                   | Required | The Google Cloud project ID.                              |
| `location`           | `string`                   | Required | The Google Cloud location, such as `us-central1`.         |
| `integration`        | `string`                   | None     | The integration name, for integration mode.               |
| `trigger`            | `string`                   | None     | The API trigger ID, for integration mode.                 |
| `connection`         | `string`                   | None     | The connection name, for connection mode.                 |
| `entityOperations`   | `Record<string, string[]>` | None     | Operations to expose, keyed by entity name.               |
| `actions`            | `string[]`                 | None     | Actions to expose.                                        |
| `toolName`           | `string`                   | `''`     | Prefix of every tool name, in connection mode.            |
| `toolInstructions`   | `string`                   | `''`     | Text added to every tool description, in connection mode. |
| `serviceAccountJson` | `string`                   | None     | A service-account key, as JSON. Without it, ADC is used.  |

`project` and `location` name where the resources live. In connection mode,
the `ExecuteConnection` integration must be in the same project and location
as the connection, because the generated tools call it there.

`integration` and `trigger` select integration mode, and only together. The
trigger is the ID Application Integration shows for the API trigger, such as
`api_trigger/process-orders`.

`connection` selects connection mode, together with `entityOperations`,
`actions`, or both. `entityOperations` maps an entity name to the operations
to expose. Give an empty list to expose every operation the entity supports,
or name operations to expose fewer, because each one is a tool the model has
to choose between.

`toolName` and `toolInstructions` shape the generated tools in connection
mode. `toolName` keeps the tool names of two connections apart when one agent
holds both, because the operation part of the names would otherwise collide.
`toolInstructions` is the place for guidance that applies to every tool of
the connection. The toolset writes the connection details after it with no
separator, so end it with a space or a full stop. Integration mode takes the
names and descriptions from the generated spec and ignores both options.

`serviceAccountJson` is the content of a service-account key file, not its
path. Use it when the process has no Application Default Credentials, or when
the integration needs a different identity from the rest of the application.
The toolset throws `serviceAccountJson must hold a JSON object.` on the first
`getTools` call when the value is JSON of another shape.

## Advanced applications

### Build the spec yourself

`ApplicationIntegrationToolset` returns every generated tool and has no tool
filter or prefix option. To select tools, or to change the spec before it
becomes tools, build the spec with `IntegrationClient` and give it to
`OpenAPIToolset`.

```ts
import {IntegrationClient, OpenAPIToolset} from '@google/adk';

const client = new IntegrationClient({
  project: 'my-project',
  location: 'us-central1',
  connection: 'my-issue-tracker',
  entityOperations: {Issues: []},
});
const spec = await client.getOpenApiSpecForConnection('tracker');

const readOnlyTools = [];
for (const [path, pathItem] of Object.entries(spec.paths)) {
  const toolset = new OpenAPIToolset({
    specStr: JSON.stringify({...spec, paths: {[path.split('#')[0]]: pathItem}}),
    toolFilter: ['tracker_list_issues', 'tracker_get_issues'],
  });
  readOnlyTools.push(...(await toolset.getTools()));
}
```

The paths of a connection spec differ only by their URL fragment, such as
`#list_Issues`. Give `OpenAPIToolset` one path at a time with the fragment
removed, as above. A path that keeps its fragment produces a tool that sends
the fragment inside the `triggerId` query parameter, and the call fails.

A spec built this way does not carry the connection details in its
descriptions, and its tools carry no credential. Read the details with
`new ConnectionsClient({project, location, connection}).getConnectionDetails()`
and pass them in the second argument of `getOpenApiSpecForConnection`. Pass
`authScheme` and `authCredential` to `OpenAPIToolset` the way the
[OpenAPI tool guide](../openapi_tool/index.md) describes.

## Limitations

- **Errors appear on the first turn, not at construction.** Only option
  validation happens in the constructor. A wrong project, a missing
  credential or an unreachable API surfaces when the agent first calls
  `getTools`, which is inside the first request it handles. Call
  `await toolset.getTools()` at startup to fail earlier.
- **Schema reads poll without a limit.** Integration Connectors answers an
  entity or action schema request with a long-running operation. The toolset
  checks it once a second until it reports that it is done, with no maximum,
  so an operation that never finishes stops the first `getTools` call from
  returning.
- **One credential for all tools.** Every generated tool carries the same
  credential. Use one toolset per identity when operations need different
  ones.
- **Connection mode depends on `ExecuteConnection`.** The tools call an
  integration of that name with the trigger `api_trigger/ExecuteConnection`.
  When it does not exist, the toolset still loads, and each tool call
  returns an error result.
- **The payload schema is simplified.** The conversion drops `required`,
  `enum`, `format` and every other keyword besides `type`, `description`,
  `properties` and `items`, so the model does not see those constraints.

## Related samples

- [samples/tools/application_integration_tool/](../../../../samples/tools/application_integration_tool/README.md) - One agent configured from environment variables for either mode.

## Related guides

- [OpenAPI tool](../openapi_tool/index.md) - The toolset that turns the generated spec into tools, and how a credential reaches each request.
