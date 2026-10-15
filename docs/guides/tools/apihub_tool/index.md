# API Hub tool

`APIHubToolset` gives an agent one tool per operation of an API registered in
Google Cloud API Hub. It fetches the API's OpenAPI spec through an API Hub
client and hands the spec to `OpenAPIToolset`, which builds the tools.

## Introduction

API Hub is a registry of the APIs an organization runs, with their versions and
their specs. When the API an agent needs is registered there, the registry
already holds the document `OpenAPIToolset` needs. `APIHubToolset` reads it
from the registry, so the agent picks up a new spec version without a copy of
the document in your repository.

Use `OpenAPIToolset` directly when you already hold the spec as a string or an
object. Use `APIHubToolset` when the spec lives in API Hub, or when you want to
plug in your own source of specs through `BaseAPIHubClient`.

The unit is four exports:

| Export                | You touch it when                                                                     |
| :-------------------- | :------------------------------------------------------------------------------------ |
| `APIHubToolset`       | Always. It turns an API Hub resource into tools and hands them to an agent.           |
| `APIHubClient`        | You want to call API Hub yourself, or configure how the toolset authenticates.        |
| `BaseAPIHubClient`    | You want the toolset to read specs from somewhere other than the API Hub REST API.    |
| `SecretManagerClient` | You keep a credential, such as a service account key, in Google Cloud Secret Manager. |

The tools themselves are `RestApiTool` instances. The
[OpenAPI tool guide](../openapi_tool/index.md) covers how they are named, what
the model sees, and how a credential reaches the request.

## Get started

This example builds a toolset from an API in API Hub and gives every operation
to an agent. Without `accessToken` or `serviceAccountJson`, the client
authenticates to API Hub with application default credentials.

```ts
import {APIHubToolset, LlmAgent} from '@google/adk';

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
});

export const rootAgent = new LlmAgent({
  name: 'api_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions by calling the API.',
  tools: [toolset],
});
```

The agent calls `toolset.getTools()` when it builds a request, and that call
waits for the spec if it is still loading.

## How it works

### From a resource name to a spec

`APIHubToolset` passes `apihubResourceName` to its client's
`getSpecContent(path)`. `APIHubClient` resolves the path to one spec in three
steps:

1. A path that names only an API resolves to the first entry of the API's
   `versions` list.
2. A path that names a version, or a version found in step 1, resolves to the
   first entry of the version's `specs` list.
3. The client reads the spec's contents, which API Hub returns base64-encoded,
   and decodes them as UTF-8. Empty contents give an empty string.

Name a version or a spec when the first one is not the one you want, because
the client does not choose between them in any other way.

`APIHubClient` accepts these forms of path:

| Form                                                                                      | Resolves to                          |
| :---------------------------------------------------------------------------------------- | :----------------------------------- |
| `projects/{p}/locations/{l}/apis/{a}`                                                     | The first spec of the first version. |
| `projects/{p}/locations/{l}/apis/{a}/versions/{v}`                                        | The first spec of that version.      |
| `projects/{p}/locations/{l}/apis/{a}/versions/{v}/specs/{s}`                              | That spec.                           |
| `https://console.cloud.google.com/apigee/api-hub/projects/{p}/locations/{l}/apis/{a}/...` | The same, read after `api-hub`.      |
| `https://console.cloud.google.com/apigee/api-hub/locations/{l}/apis/{a}?project={p}`      | The project comes from the query.    |

A leading or trailing slash is ignored, and names keep their case. A `specs`
segment without a `versions` segment is ignored, so the spec is found through
the API's first version. The project comes from a `projects/{p}` segment when
there is one, and from the `project` query parameter otherwise. The location
always comes from the path, so a console URL without a `locations/{l}` segment
is rejected.

A path without a project, a location or an API throws before any request is
sent. The messages start with `Project ID not found in URL or path in
APIHubClient.`, `Location not found in URL or path in APIHubClient.` and `API id
not found in URL or path in APIHubClient.`, and they quote the input. An API
with no versions throws `No versions found in API Hub resource: <api>`, and a
version with no specs throws `No specs found in API Hub version: <version>`.

### From a spec to tools

The toolset parses the spec with `js-yaml`, which also reads JSON. An empty
spec gives no tools. Otherwise the toolset fills in its own fields and builds
an `OpenAPIToolset` from the parsed document:

- When `name` is empty, it becomes the spec's `info.title` in snake_case, so
  `Mock API` becomes `mock_api`. A spec with no title gives `unnamed`.
- When `description` is empty, it becomes the spec's `info.description`, or
  stays empty.
- `authScheme` and `authCredential` are passed to `OpenAPIToolset`, which
  applies them to every tool.

`getTools(context)` and `getTool(name)` then delegate to that `OpenAPIToolset`.
`getTool` returns a Promise, unlike `OpenAPIToolset.getTool`, because the spec
may still be loading. Await it:

```ts
const tool = await toolset.getTool('get_pet');
```

Invalid YAML rejects with the `YAMLException` that `js-yaml` throws.

### Eager and lazy loading

The toolset starts fetching the spec in its constructor by default. A
constructor cannot wait for a request, so the fetch runs in the background and
a failure is reported by the first `getTools` or `getTool` call. Every later
call reports the same failure. Construct a new toolset to try again.

With `lazyLoadSpec: true`, nothing is fetched until the first `getTools` or
`getTool` call. A successful result is kept, including a spec that produced no
tools. A failed fetch is not kept, so the next call fetches again. Lazy loading
suits a module that builds agents at import time, because importing it then
does no network I/O.

In both modes, `name` and `description` are filled in only when the spec has
loaded. Read them after awaiting `getTools()`.

### Authenticating to API Hub

`APIHubClient` sends every request with an `Authorization: Bearer <token>`
header. The token comes from the first of these that applies:

1. `accessToken`, sent as given. It is not refreshed, so a short-lived token
   such as the output of `gcloud auth print-access-token` stops working when it
   expires.
2. `serviceAccountJson`, the text of a service account key file. The client
   mints tokens from it with the `https://www.googleapis.com/auth/cloud-platform`
   scope.
3. Application default credentials, with the same scope.

For the last two, `google-auth-library` caches the token and refreshes it
before it expires. A key that does not parse throws `Invalid service account
JSON: <reason>` on the first request. A key that parses but cannot mint a
token, for example because it was revoked, throws `Failed to get an access
token for API Hub client from the given service account: <reason>`. When no
credential is given and application default credentials cannot be found, the
request throws `Please provide a service account or an access token to API Hub
client.`

The API Hub credential and `authCredential` are separate. The first reads the
spec from API Hub; the second goes on the requests the tools send to the API
the spec describes.

## Configuration options

### APIHubToolset

| Option               | Type                             | Default              | Description                                                                                |
| :------------------- | :------------------------------- | :------------------- | :----------------------------------------------------------------------------------------- |
| `apihubResourceName` | `string`                         | Required             | The API, version or spec to read, in any form listed above.                                |
| `accessToken`        | `string`                         | `undefined`          | Bearer token for API Hub. Ignored when `apihubClient` is set.                              |
| `serviceAccountJson` | `string`                         | `undefined`          | Service account key text for API Hub. Ignored when `accessToken` or `apihubClient` is set. |
| `name`               | `string`                         | `''`                 | The toolset name. Empty means the spec title in snake_case.                                |
| `description`        | `string`                         | `''`                 | The toolset description. Empty means the spec description.                                 |
| `lazyLoadSpec`       | `boolean`                        | `false`              | Fetch the spec on first use instead of at construction.                                    |
| `authScheme`         | `OpenAPIV3.SecuritySchemeObject` | `undefined`          | Auth scheme applied to every tool.                                                         |
| `authCredential`     | `AuthCredential`                 | `undefined`          | Auth credential applied to every tool.                                                     |
| `apihubClient`       | `BaseAPIHubClient`               | A new `APIHubClient` | The client that fetches the spec.                                                          |

`apihubResourceName` is passed to the client unchanged, so a custom client can
give it any meaning it likes. The default client parses it as described in
[From a resource name to a spec](#from-a-resource-name-to-a-spec).

`name` and `description` are public fields as well as options. They are filled
in from the spec only when they are empty, so an explicit value always wins.

`authScheme` and `authCredential` take the same types as the `OpenAPIToolset`
options, and `tokenToSchemeCredential` builds a matching pair:

```ts
import {APIHubToolset, tokenToSchemeCredential} from '@google/adk';

const [authScheme, authCredential] = tokenToSchemeCredential(
  'apikey',
  'header',
  'X-API-Key',
  process.env.MY_API_KEY,
);

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  authScheme,
  authCredential,
});
```

### APIHubClient

| Option               | Type     | Default     | Description                                                 |
| :------------------- | :------- | :---------- | :---------------------------------------------------------- |
| `accessToken`        | `string` | `undefined` | Bearer token sent as given. Wins over `serviceAccountJson`. |
| `serviceAccountJson` | `string` | `undefined` | Service account key text, used to mint tokens.              |

With neither option, the client uses application default credentials. Besides
`getSpecContent`, the client has three methods that return API Hub resources:

| Method                          | Returns                                                        |
| :------------------------------ | :------------------------------------------------------------- |
| `listApis(project, location)`   | `APIHubApi[]`, or `[]` when there are none.                    |
| `getApi(apiResourceName)`       | `APIHubApi`, with `name` and the optional `versions` list.     |
| `getApiVersion(apiVersionName)` | `APIHubApiVersion`, with `name` and the optional `specs` list. |

A response that is not a 2xx status throws
`API Hub request failed with status <status>: <url>`.

### SecretManagerClient

| Option               | Type     | Default     | Description                                      |
| :------------------- | :------- | :---------- | :----------------------------------------------- |
| `serviceAccountJson` | `string` | `undefined` | Service account key text. Wins over `authToken`. |
| `authToken`          | `string` | `undefined` | An OAuth access token, sent as given.            |

With neither option, the client uses application default credentials. When
they cannot be resolved, `getSecret` throws, and the next call tries again. The
constructor throws `Invalid service account JSON: <reason>` for a key that does
not parse, so a bad key is reported where it is configured.

`getSecret(resourceName)` takes a secret version in the form
`projects/{project}/secrets/{secret}/versions/{version}` and returns its
payload as a UTF-8 string. Use `latest` as the version to read the newest one.
An error from Secret Manager, such as a missing secret or a denied permission,
is rethrown unchanged.

## Advanced applications

### Reading specs from your own source

The toolset only calls `getSpecContent`, so any object with that method can
replace `APIHubClient`. A custom client can add a cache, read specs from a file
or another registry, or stand in for API Hub in a test.

```ts
import {APIHubToolset, BaseAPIHubClient} from '@google/adk';
import {readFile} from 'node:fs/promises';

class LocalSpecClient implements BaseAPIHubClient {
  async getSpecContent(path: string): Promise<string> {
    return readFile(`./specs/${path}.yaml`, 'utf8');
  }
}

const toolset = new APIHubToolset({
  apihubResourceName: 'petstore',
  apihubClient: new LocalSpecClient(),
});
```

### Keeping the API Hub key in Secret Manager

`SecretManagerClient` is a standalone helper; the toolset does not call it. One
use is to keep the service account key for API Hub out of your environment and
read it at startup:

```ts
import {APIHubToolset, SecretManagerClient} from '@google/adk';

const secrets = new SecretManagerClient();
const serviceAccountJson = await secrets.getSecret(
  'projects/my-project/secrets/apihub-key/versions/latest',
);

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  serviceAccountJson,
});
```

### Exploring API Hub

`APIHubClient` is usable on its own, for example to list the APIs a project
registers before you pick one:

```ts
import {APIHubClient} from '@google/adk';

const client = new APIHubClient();
const apis = await client.listApis('my-project', 'us-central1');
const apiNames = apis.map((api) => api.name);
```

## Limitations

**Optional peer dependency.** `SecretManagerClient` needs
`@google-cloud/secret-manager`, which `@google/adk` declares as an optional
peer so that applications without it do not download it. It is loaded on the
first `getSecret` call. When it is missing, that call throws an error naming
the install command:

```bash
npm install @google-cloud/secret-manager
```

The version `@google/adk` declares, `^7.1.1`, requires Node.js 22 or later.
`APIHubClient` and `APIHubToolset` need no extra package.

**Node.js only.** The four exports come from the Node entry point of
`@google/adk`, not from the browser bundle, because they depend on
`google-auth-library`.

**One spec per toolset.** The toolset reads exactly one spec, the first one
unless the resource name says otherwise. An API with several specs needs one
toolset per spec. The toolset has no `toolFilter` or `prefix` option, so it
always exposes every operation in the spec.

**No pagination.** `listApis` makes one request and returns the APIs in that
response. A project with more APIs than API Hub returns in one page shows only
the first page.

**Eager failures stick.** A toolset whose eager fetch failed keeps reporting
that failure. Use `lazyLoadSpec: true` when a later call should try again.

**Experimental.** `APIHubToolset` and the `OpenAPIToolset` and
`RestApiTool` classes it builds carry the `@experimental` decorator. Using
them logs warnings, and their behavior may change between minor versions.

## Related samples

- [API Hub tool](../../../../samples/tools/apihub_tool/README.md) - A toolset built from a local stand-in for API Hub by default, or from a real API Hub resource when one is configured.
- [Tool samples](../../../../samples/tools/README.md) - The category the sample lives in, and what CI does and does not run for it.

## Related guides

- [OpenAPI tool](../openapi_tool/index.md) - The toolset `APIHubToolset` hands the spec to, how tools are named, and how a credential reaches the request.
- [Auth](../../auth/index.md) - `AuthCredential` and the other credential types that `authCredential` accepts.
