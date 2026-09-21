# OpenAPI tool

`OpenAPIToolset` reads an OpenAPI v3 document and gives an agent one tool per
operation in it. The rest of `core/src/tools/openapi_tool/` is the pipeline
behind that sentence: a spec parser, an operation parser, the HTTP tool the
model actually calls, and the auth machinery that puts a credential on the
request.

## Introduction

An HTTP API that publishes an OpenAPI document has already written down
everything a tool needs: the operation name, the parameters, their types and
descriptions, and the security scheme. Writing a `FunctionTool` per endpoint
restates all of it by hand, twice — once for the model and once for the network
— and the two copies drift as the API changes. `OpenAPIToolset` reads the
document instead, so the spec stays the single source of truth and the agent
gains a tool the next time the spec is loaded.

Reach for it when the API you want the agent to call has a spec. Write a
`FunctionTool` when there is no spec, when the call is not HTTP, or when you
want the model to see an operation that does not map to one endpoint. For a
tool server speaking the Model Context Protocol rather than plain HTTP, use
`MCPToolset`.

Most callers touch two classes. The rest are the stages `OpenAPIToolset` runs
for you, exported because you sometimes want one on its own.

| Class                         | You touch it when                                                                        |
| :---------------------------- | :--------------------------------------------------------------------------------------- |
| `OpenAPIToolset`              | Always. It turns a document into tools and hands them to an agent.                       |
| `RestApiTool`                 | You have one operation rather than a document, or you are reading a tool it built.       |
| `OpenApiSpecParser`           | You want the operations without the tools — to filter a large document, or report on it. |
| `OperationParser`             | You hold one operation and want its name, schema or generated documentation.             |
| The auth helpers              | You are supplying a credential the spec does not describe.                               |
| `ToolAuthHandler`             | You are writing your own tool against an OpenAPI-style scheme, or testing one.           |
| `AutoAuthCredentialExchanger` | The API wants a credential shape ADK does not derive for you.                            |
| `BaseAuthCredentialExchanger` | You are writing a synchronous exchanger in adk-python's shape.                           |

Everything in this directory carries the `@experimental` decorator. Calling it
logs one warning per class and the surface may change between minor versions.

## Get started

A spec string, the format it is written in, and an agent to hand the tools to.

```ts
import {LlmAgent, OpenAPIToolset} from '@google/adk';

const petstoreToolset = new OpenAPIToolset({
  specStr: `---
openapi: 3.0.0
info:
  title: Pet store
  version: 1.0.0
servers:
  - url: https://petstore.example.com
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: One pet.
`,
  specType: 'yaml',
});

export const rootAgent = new LlmAgent({
  name: 'petstore_agent',
  model: 'gemini-flash-latest',
  description: 'Answers questions about the pet store.',
  instruction: 'Use get_pet to look up a pet by its identifier.',
  tools: [petstoreToolset],
});
```

The agent now sees one function named `get_pet`, taking a `pet_id` string. A
`BaseToolset` goes into `tools` whole, alongside ordinary tools.

Most APIs also want a credential. `tokenToSchemeCredential` returns the scheme
and the credential together, and the toolset applies both to every tool it
built:

```ts
import {OpenAPIToolset, tokenToSchemeCredential} from '@google/adk';

const [authScheme, authCredential] = tokenToSchemeCredential(
  'apikey',
  'query',
  'api_key',
  process.env.NASA_API_KEY,
);

const toolset = new OpenAPIToolset({specStr, authScheme, authCredential});
```

## How it works

The constructor does all the parsing, so a toolset is ready as soon as it
exists. Three stages run before any agent sees a tool, and a fourth runs on
every call.

**1. The document becomes operations.** `OpenApiSpecParser` resolves every
internal `$ref` to the value it points at, normalizes schema types for Gemini
function calling, resolves server URL variables, merges path-level parameters
into each operation, and walks the paths producing one `ParsedOperation` per
HTTP method. It is synchronous and does no I/O: it never calls the API the
document describes.

`ParsedOperation` is the hand-off between the stages:

| Field            | Type                                | What it holds                                                        |
| :--------------- | :---------------------------------- | :------------------------------------------------------------------- |
| `name`           | `string`                            | The tool function name, derived from the operation id.               |
| `description`    | `string`                            | The operation's `description`, or its `summary`, or an empty string. |
| `endpoint`       | `OperationEndpoint`                 | `baseUrl`, `path` and `method`.                                      |
| `operation`      | `OpenAPIV3.OperationObject`         | The operation, with references resolved and types normalized.        |
| `parameters`     | `ApiParameter[]`                    | Every parameter, flattened across query, header, path, cookie, body. |
| `returnValue`    | `ApiParameter \| undefined`         | The schema of the first 2xx response that has content.               |
| `authScheme`     | `SecuritySchemeObject \| undefined` | The security scheme that applies to this operation.                  |
| `authCredential` | `AuthCredential \| undefined`       | The credential to use. The parser leaves it undefined.               |

The parser fills the first seven. `authCredential` is for a caller assembling a
`ParsedOperation` by hand, because `createRestApiTool` reads it.

**2. Each operation becomes a flat argument list.** An OpenAPI operation states
its inputs in three places — `parameters`, `requestBody` under a media type,
and the properties of an object body one level deeper — and a model needs one
list. `OperationParser` flattens them. An object body contributes one parameter
per property, so the model fills in named fields rather than a nested JSON
blob; an array or primitive body contributes a single parameter named `body`.
Every parameter records `paramLocation`, which is how `RestApiTool` puts the
value back where the request wants it, and `originalName`, which is what goes
on the wire.

**3. Each operation becomes a tool.** `OpenAPIToolset` builds a `RestApiTool`
per operation, applies `prefix` to the name, and applies the `authScheme` and
`authCredential` overrides last, so they reach every tool including ones a
filter later hides. Every tool is logged at `info` as `Parsed tool: <name>`,
which is how you check a spec produced the names you expected.

**4. On each call, the tool assembles a request.** `RestApiTool` prepares the
credential through `ToolAuthHandler`, places each argument according to the
`in` value of the parameter it came from — path arguments percent-encoded and
substituted, query arguments appended, header arguments set, cookie arguments
serialized into one `Cookie` header, body arguments assembled using the first
media type the request body declares — sends it, and parses the response as
JSON when the server says it is JSON.

### Names the model sees

The tool name comes from `operationId`, converted to snake_case: `getPet`
becomes `get_pet`, `getHTTPResponse` becomes `get_http_response`. Characters
that are already separators survive, so an `operationId` of
`calendar.calendars.get` yields that name with the dots intact. Read the logged
names rather than predicting them.

A document that declares no `operationId` gets a generated one, from the path
and the method in snake_case: `/users/{id}` with `get` becomes `users_id_get`.
That is the same name adk-python produces for the same operation, so a prompt
or an allowlist written for one SDK carries over.

Parameter names are snake_cased the same way unless `preservePropertyNames` is
set, and two that collide — a `userId` query parameter and a `user_id` body
property both become `user_id` — are disambiguated with `_1`, `_2` and so on,
because a function declaration cannot carry the same argument twice. A name
that is one of the 46 ECMAScript reserved words is prefixed, so an OpenAPI
parameter named `in` reaches the model as `param_in`.

The snake-case pass follows adk-python exactly, including the results that look
wrong in isolation: `XMLHTTPRequest` becomes `xmlhttp_request` and `fromAtoB`
becomes `from_ato_b`. Matching those matters more than improving them, because
a mismatch renames a parameter between the two SDKs.

### What the declaration looks like

The declaration the model receives is a Gemini `Schema`, not the raw OpenAPI
schema, and the two are not the same language. The conversion keeps the fields
Gemini declares, drops `title`, `default` and `format` because the backend
refuses them, and gives an operation with no arguments a placeholder property
named `dummy_DO_NOT_GENERATE`, because the backend also refuses an object type
with no properties. A schema whose `type` is outside Gemini's set — `array`,
`boolean`, `integer`, `null`, `number`, `object`, `string` — has its type
dropped rather than mapped to a near equivalent, because a schema with no type
is valid and a schema Gemini rejects fails the whole declaration.

`_getDeclaration()` on a `RestApiTool` returns what the model will see, which
is the fastest way to confirm a parameter survived parsing under the name you
expect.

```ts
const declaration = toolset.getTool('get_pet')?._getDeclaration();
const parameterNames = Object.keys(declaration?.parameters?.properties ?? {});
```

The prose the model reads alongside it is generated in adk-python's format, by
`OperationParser.getPydocString()` and the helpers in `common/common.ts`. The
type tokens in that text are Python's — `str`, `int`, `List[str]`,
`Dict[str, Any]`, `Any` — in a TypeScript SDK, deliberately: identical text
across the two SDKs is what gives identical model behaviour for the same spec.

### What a failed call returns

Two outcomes are error objects rather than exceptions:

| Outcome             | What the tool returns                               |
| :------------------ | :-------------------------------------------------- |
| A non-2xx response  | `{error: 'Tool <name> execution failed. … <body>'}` |
| A transport failure | `{error: 'Failed to execute API call: <message>'}`  |

Returning the failure is deliberate. The model is the caller, and it can act on
a failure it can read: correct an argument, try another value, or tell the user.
An exception would end the turn instead. The message names the tool and
includes the response body, and tells the model to stop after three attempts,
because a model that reads only "the call failed" tends to repeat the call.
Say in the agent's instruction what to do with an error, or it may report the
error text as though it were the answer.

## Configuring authentication

### Building the scheme and credential pair

An `authScheme` says where the credential travels; an `authCredential` carries
the secret. The two have to agree — an `apiKey` scheme expects a credential
carrying `apiKey`, a bearer scheme expects `http.credentials.token` — and a
pair that does not agree fails at the first request with a header the service
does not accept. The helpers exist so you state the intent once and get both
halves back together, as a tuple, in the same order adk-python returns them.

| Helper                                 | Returns                                                                  |
| :------------------------------------- | :----------------------------------------------------------------------- |
| `tokenToSchemeCredential`              | An `apiKey` or bearer scheme, and the matching credential.               |
| `serviceAccountDictToSchemeCredential` | A bearer scheme, and a service-account credential built from a key file. |
| `serviceAccountSchemeCredential`       | A bearer scheme, and a service-account credential you already built.     |
| `openidDictToSchemeCredential`         | An `OpenIdConnectWithConfig` scheme, and an OpenID Connect credential.   |
| `openidUrlToSchemeCredential`          | The same pair, from a discovery URL that the helper fetches.             |
| `dictToAuthScheme`                     | One `AuthScheme`, validated against the shape its `type` requires.       |
| `credentialToParam`                    | The tool parameter carrying a credential, and the value to send for it.  |

Everything that ends as a bearer token pairs with one scheme,
`{type: 'http', scheme: 'bearer', bearerFormat: 'JWT'}`. A service account, an
OAuth2 token and an OpenID Connect token all reach the service the same way, in
an `Authorization` header, so they share a scheme rather than having three.

Omit the credential argument to build a scheme alone; the credential comes back
`undefined`, which is what you want when it arrives later from a credential
service. `openidUrlToSchemeCredential` fetches the discovery document, times out
after 10 seconds, and unwraps the single `web` or `installed` key a downloaded
Google client-secret file wraps its fields in, so you pass the parsed file
rather than the object inside it.

### Where the credential lands

`in: 'header'` sets that header, `in: 'query'` appends the parameter,
`in: 'cookie'` sets a cookie, and a credential with no `apiKey` but an
`http.credentials.token` becomes `Authorization: Bearer <token>` whatever the
scheme says.

The toolset's pair is an override, applied to every tool after parsing, and it
replaces what the spec declared per operation. Use it when the spec describes an
API you reach with one key, which is the common case for a first-party API. Give
each service its own toolset when two need different credentials.

Where the spec does declare security, `OpenApiSpecParser` reads it: an
operation's own `security` wins over the document-level `security`, the first
scheme name is looked up in `components.securitySchemes`, and the parser reports
the scheme without choosing a credential, because what to send is a decision
`RestApiTool` and `ToolAuthHandler` make at call time.

### Preparation, exchange and consent

`ToolAuthHandler` decides what the tool actually sends. An `apiKey` scheme needs
only the configured key; an OAuth2 authorization-code flow needs a person at a
consent screen. A tool call cannot wait for a person, so the handler models the
difference as two outcomes: `done` when it has a credential, and `pending` when
the client has to supply one and the call has to be tried again.

`prepareAuthCredentials` returns from the first of four steps that produces a
credential:

1. **No scheme.** `{state: 'done'}`, no credential.
2. **The store.** A credential cached under this scheme and credential pair is
   returned as it is. Nothing is exchanged and nothing is written.
3. **A credential to work with.** `Context.getAuthResponse` returns what the
   client supplied interactively; with none, the handler falls back to the
   credential the tool was configured with, because `apiKey`, `http` and
   `serviceAccount` need no interaction and requesting one would leave the tool
   pending forever.
4. **The exchange.** The exchanger converts that credential. On success the
   result is `done`. On failure, or with no credential from step 3, the handler
   asks the client for one and returns `pending`.

A `pending` result means the handler has parked an auth request in
`eventActions.requestedAuthConfigs`, and the invocation ends. Your application
collects the credential, resumes the run, and the tool call runs again from the
top, where step 3 finds the answer. The handler holds no state between the two
attempts; the session does.

The handler writes to the store only when the credential cost something to
obtain — it came from an auth response, which is readable once, or the exchanger
reported `wasExchanged`. A statically configured credential is available on
every invocation already, so caching it would copy a secret into session state
for no gain. The cache key is derived from both the scheme and the credential:

```
${scheme.type}_${hash(scheme)}_${credential.authType}_${hash(credential)}_existing_exchanged_credential
```

Both operands are in it because either alone collides: two `apiKey` schemes
against different hosts would share a slot, and so would two credentials under
one scheme. The key carries no `temp:` prefix, deliberately — temp state is
cleared at the end of a run and an exchanged access token is worth keeping.

`credentialKey` is a different thing, and confusing the two is the easy mistake.
It names the auth request the client answers, travelling in the `AuthConfig` the
client sees, and it defaults to `default_openapi_key`, so two tools that leave
it unset read each other's answer. It is not the cache key: two tools sharing a
`credentialKey` still cache separately.

`ToolContextCredentialStore` is exported so you can read what the handler wrote,
or drop a token the API has started rejecting so the next call exchanges again.
`getCredential` re-validates what it reads and throws with the key named when
something else has written there, rather than returning `undefined` and hiding
it. `removeCredential` writes `undefined` rather than deleting, since `State`
has no delete, and `State.get` returns `undefined` either way.

```ts
import {ToolContextCredentialStore} from '@google/adk';

const store = new ToolContextCredentialStore(context);
store.removeCredential(store.getCredentialKey(scheme, credential));
```

### The exchangers

`AutoAuthCredentialExchanger` is the dispatcher. It reads
`authCredential.authType` and calls the exchanger registered for it:

| Auth credential type | Exchanger                           |
| :------------------- | :---------------------------------- |
| `OAUTH2`             | `OAuth2CredentialExchanger`         |
| `OPEN_ID_CONNECT`    | `OAuth2CredentialExchanger`         |
| `SERVICE_ACCOUNT`    | `ServiceAccountCredentialExchanger` |

Three results are worth telling apart. An absent credential resolves to `null`
and calls no exchanger. A type with no registered exchanger resolves to the
original credential with `wasExchanged: false` — an unrecognized type is a
credential that needs no conversion, not an error. A type with an exchanger
returns that exchanger's `ExchangeResult`, and an error it throws propagates
unwrapped. `wasExchanged` is what separates the second case from the third, and
it is why the class returns a result object rather than a bare credential.

`ServiceAccountCredentialExchanger` takes one of two paths. With key material in
`serviceAccount.serviceAccountCredential` it signs a JWT and trades it for an
access token; with `useDefaultCredential: true` it asks `google-auth-library`
for application default credentials, which is the identity Cloud Run, GKE and
Compute Engine attach to a workload. Prefer the second in a hosted service: it
keeps a private key out of your configuration. The flag wins when both are set,
and setting neither throws `AuthCredentialMissingError` naming the flag. Every
failure surfaces as `AuthCredentialMissingError`, with a message naming the path —
`Failed to exchange default service account token` or
`Failed to exchange explicit service account token`.

Pass `customExchangers` to add a type the defaults do not cover, or to replace
one. The merge writes over the default map entry by entry, so replacing the
`OAUTH2` entry leaves `OPEN_ID_CONNECT` pointing at its default, and an entry
whose value is `undefined` leaves the default in place rather than clearing it.

```ts
import {
  AuthCredentialTypes,
  AutoAuthCredentialExchanger,
  BaseCredentialExchanger,
  ExchangeResult,
} from '@google/adk';

class ApiKeyToBearerExchanger implements BaseCredentialExchanger {
  async exchange(params: {
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    return {
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: `bearer-${params.authCredential.apiKey}`},
        },
      },
      wasExchanged: true,
    };
  }
}

const exchanger = new AutoAuthCredentialExchanger({
  [AuthCredentialTypes.API_KEY]: new ApiKeyToBearerExchanger(),
});
```

adk-js ships two exchanger abstractions and they are not interchangeable. The
asynchronous `BaseCredentialExchanger`, above, returns an `ExchangeResult` and
is what everything in this directory uses. The synchronous
`BaseAuthCredentialExchanger` returns a bare `AuthCredential`, matches
adk-python's shape under
`tools/openapi_tool/auth/credential_exchangers/`, and cannot await a token
endpoint. Its base `exchangeCredential` always throws
`Subclasses must implement exchangeCredential.`, so a subclass that forgets to
override fails on its first call rather than returning something the API
rejects later. Its companion error is `AuthCredentialMissingError`.

**In `ServiceAccountCredentialExchanger`, a missing credential and a failed
exchange are the same type.** Both raise `AuthCredentialMissingError`, so a
`catch` that retries on exchange failure will also swallow a missing client
secret. adk-python draws no distinction either — `service_account_exchanger.py`
raises that one type at both `:68` and `:95` — and this port follows the
reference rather than inventing a split it does not have. A caller that needs to
tell the two apart has to read the message: the exchange-failure messages name
the path (`Failed to exchange default service account token`), while the
missing-credential messages name what is absent.

**`OAuth2CredentialExchanger` is different: it throws a plain `Error`.** So
`catch (e) { if (e instanceof AuthCredentialMissingError) … }` will miss the
OAuth2 case entirely. The split is not this port's taste — it follows
adk-python, where the service-account exchanger raises
`AuthCredentialMissingError` and `oauth2_exchanger.py` raises `ValueError`
(`:37`, `:46`, `:52`), and a Python-only error type becomes a plain `Error`
here. A missing OAuth2 **client secret** is separate again and does raise
`AuthCredentialMissingError`, from `tool_auth_handler.ts:276` and `:281`, so the
retry-catch warning above still holds for that case.

## Configuration options

### OpenAPIToolset

One options object; nothing is positional.

| Option                  | Type                                                   | Default     | Description                                       |
| :---------------------- | :----------------------------------------------------- | :---------- | :------------------------------------------------ |
| `specDict`              | `OpenAPIV3.Document`                                   | `undefined` | The spec as an already-parsed object.             |
| `specStr`               | `string`                                               | `undefined` | The spec as JSON or YAML text.                    |
| `specType`              | `'json' \| 'yaml'`                                     | inferred    | The format of `specStr`.                          |
| `toolFilter`            | `ToolPredicate \| string[]`                            | `[]`        | Which tools `getTools()` exposes.                 |
| `prefix`                | `string`                                               | `undefined` | Prepended to every tool name.                     |
| `preservePropertyNames` | `boolean`                                              | `false`     | Keep spec property names instead of snake_casing. |
| `authScheme`            | `OpenAPIV3.SecuritySchemeObject`                       | `undefined` | Security scheme applied to every tool.            |
| `authCredential`        | `AuthCredential`                                       | `undefined` | Credential applied to every tool.                 |
| `credentialKey`         | `string`                                               | `undefined` | Names the auth request the client answers.        |
| `headerProvider`        | `(context: ReadonlyContext) => Record<string, string>` | `undefined` | Extra headers computed per call.                  |

Supply `specDict` or `specStr`. `specDict` skips parsing and wins when both are
present; neither throws `Either specDict or specStr must be provided.`
`specType` throws `Unsupported spec type: <value>` for anything but `json` or
`yaml` — TypeScript rejects a bad literal, so you see this when the value came
from configuration read at run time. Omitting it turns on a sniff: text whose
first non-space characters are `---` is read as YAML and anything else as JSON.
The sniff is a convenience, not a parser; a YAML document without the leading
`---` is read as JSON and fails. Pass `specType` whenever you know the format.

`toolFilter` narrows `getTools()`. A `string[]` lists names to keep and applies
whether or not a context is supplied; a `ToolPredicate` takes the tool and a
`ReadonlyContext` and applies only when `getTools()` receives one. Use the array
to trim a large spec, the predicate when the answer depends on who is asking.

`prefix` prepends `<prefix>_` to every name, so two toolsets on one agent can
both contain a `get_user`. It is applied while the tools are built, so it is
part of the stored name: a toolset built with `prefix: 'crm'` answers
`getTool('crm_get_user')`.

`preservePropertyNames` keeps the spelling the spec uses, so `calendarId`
reaches the model as `calendarId` rather than `calendar_id`. Turn it on when a
name is meaningful as written or a downstream consumer matches on it. The cost
is that two parameters differing only in case stay distinct where the conversion
would have merged them. `originalName` is kept either way and is what goes on
the wire, so the conversion never changes the request.

`headerProvider` is called on every invocation and its result is merged over the
headers built from the operation, so it wins a conflict. Use it for a header
whose value depends on the run rather than the operation — a tenant identifier
from session state, a trace id — which a static credential cannot express.

### RestApiTool

The first six constructor arguments are the name, description, endpoint,
operation, auth scheme and auth credential. The seventh is options.

| Option                  | Type                                                   | Default     | Description                                                             |
| :---------------------- | :----------------------------------------------------- | :---------- | :---------------------------------------------------------------------- |
| `preservePropertyNames` | `boolean`                                              | `false`     | Offers OpenAPI names to the model unchanged, instead of `snake_case`.   |
| `headerProvider`        | `(context: ReadonlyContext) => Record<string, string>` | `undefined` | Supplies extra headers per call, from the invocation context.           |
| `credentialKey`         | `string`                                               | `undefined` | Names the credential this tool asks the client for.                     |
| `operationParser`       | `OperationParser`                                      | `undefined` | Uses a parser the caller built, instead of parsing the operation again. |

`operationParser` exists for a caller that has already parsed the operation.
`createRestApiTool` sets it when its input carries `parameters`, and
`OpenAPIToolset` reaches that path for every tool it builds, so an operation the
spec parser walked is not walked twice. The supplied parser stays authoritative,
so a parameter it renamed is not renamed back.

## Advanced applications

### Selecting one operation

`getTools()` applies `toolFilter`; `getTool(name)` is a direct lookup over
everything the spec produced and applies none, because the filter decides what
one agent exposes to a model rather than what the toolset holds. A tool excluded
from `getTools()` still resolves through `getTool()`.

```ts
const getPet = toolset.getTool('get_pet');
if (!getPet) {
  throw new Error('The spec did not produce a get_pet tool.');
}

export const petLookupAgent = new LlmAgent({
  name: 'pet_lookup_agent',
  model: 'gemini-flash-latest',
  description: 'Looks up one pet by identifier.',
  tools: [getPet],
});
```

The two lines of checking are worth it. A spec that changed under you returns
`undefined`, and the agent would otherwise be built with a missing tool and fail
when the model calls it.

### Parsing without building tools

Filtering a large document before building tools is the usual reason to call
`OpenApiSpecParser` directly. Parse once, decide what to keep, build only those.

```ts
import {OpenApiSpecParser} from '@google/adk';

const readOnly = new OpenApiSpecParser()
  .parse(spec)
  .filter((operation) => operation.endpoint.method === 'get');
```

`returnValue.paramSchema` is the schema of the first 2xx response with
references already resolved, so it is what you need to generate a return type or
to decide whether an operation is worth exposing at all.

### Building a tool from one operation

A parsed operation, from the spec parser or written by hand, becomes a tool
through `createRestApiTool`. Omit the name and description and they are derived
from the operation: the name from `operationId`, the description from
`description` or, failing that, `summary`.

```ts
import {createRestApiTool, OpenApiSpecParser} from '@google/adk';

const tools = new OpenApiSpecParser().parse(document).map(createRestApiTool);
```

The same operation in serialized form goes through `createRestApiToolFromJson`.
That is the only entry point taking undecoded input, so it is the only one that
validates what it received: a stored operation whose auth scheme names an
unknown `type` is rejected there rather than when the credential is applied.

A scheme and a credential can also be supplied after construction, which is how
the toolset applies one credential to every tool it built:

```ts
tool.configureAuthScheme({type: 'apiKey', name: 'X-Api-Key', in: 'header'});
tool.configureAuthCredential({authType: AuthCredentialTypes.API_KEY, apiKey});
```

### Reading one operation on its own

`OperationParser` produces the four artifacts a declaration is built from:

```ts
const parser = new OperationParser(operation);

parser.getFunctionName(); // 'find_pets_by_status'
parser.getReturnTypeHint(); // 'List[Dict[str, Any]]'
parser.getJsonSchema(); // {type: 'object', properties: {status: …}, …}
parser.getPydocString(); // the docstring the model reads
```

It accepts the operation as a typed object, a plain object, or a JSON string, so
a cached operation does not have to be revived first. `OperationParser.load`
rebuilds a parser from parameters that were already parsed, storing them as
given rather than reprocessing them — the point being that a caller who cached a
parsed operation gets the names it cached, not names generated a second time
under a possibly different policy.

`createApiParameter`, `generateParamDoc`, `generateReturnDoc` and `getTypeHint`
in `common/common.ts` are the same rendering as free functions, for a caller
assembling a tool description by hand. `OperationParser` does not call them — it
derives its own names and uses the operation's `description` verbatim — so they
changed nothing about the tools `OpenAPIToolset` builds.

### Substituting the exchanger in a test

The exchanger is the only part of the auth path that makes a network call, so
substituting it makes the whole path testable without one.

```ts
const handler = new ToolAuthHandler(context, scheme, credential, {
  credentialExchanger: {
    async exchange() {
      return {
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'test-token'}},
        },
        wasExchanged: true,
      };
    },
  },
});
```

The exchanger is resolved when `prepareAuthCredentials` runs rather than in the
constructor, so a caller that replaces the exchanger module sees the
replacement.

## Limitations

**Documents.** OpenAPI v3 only. Nothing fetches a spec for you: `specStr` is
text you already read, and there is no URL option. A `$ref` into another file
throws `External references not supported: <ref>`, so a document that uses them
has to be bundled first. A `$ref` cycle stops at the second visit, keeping the
repeated node's siblings and dropping its `$ref`, which ends the recursion and
leaves a finite object.

Wherever OpenAPI allows a list, the parser reads the first entry: the first
server, the first security scheme, the first media type of a request or response
body. A document that depends on the second needs the caller to reorder it. An
operation whose 2xx response declares no schema gets `{}` as its return value
rather than `undefined`, which says "something comes back and the document does
not describe it".

`OperationParser` used on its own sees only the operation: document-level
`security` is invisible to `getAuthSchemeName()`, which reports `''`, and a
`$ref` in a body schema is skipped rather than resolved, so the parameter list
quietly omits it. Operations reaching it through `OpenApiSpecParser.parse` are
already resolved and unaffected. Response codes are compared as strings when the
return value is chosen, which is right for three-digit codes and wrong for a
wildcard key such as `2XX`.

**Requests.** The tool name is capped at 60 characters, so two operations whose
names differ only after the 60th character collide, and a `toolFilter` matching
on the full name stops matching. A cookie parameter goes out as a `Cookie`
header because `fetch` has no cookie option, and a `Cookie` header the operation
declares itself takes precedence — the tool then sends no cookie parameters at
all rather than merging the two. A query parameter whose value is `undefined`,
`null` or the empty string is not sent; `0` and `false` are sent, which differs
from adk-python, where every falsy value is dropped. For a `multipart/form-data`
or `application/x-www-form-urlencoded` body the tool does not set
`Content-Type`, because a literal `multipart/form-data` header omits the MIME
boundary and the request then fails to parse. A path parameter whose value is
`.` or `..` is rejected rather than encoded, since URL normalization resolves a
percent-encoded dot segment exactly like a literal one.

**Credentials.** Basic authentication is not supported: `credentialToParam`
throws for a credential carrying a username or password rather than encoding
them. The credential cache lives in session state, which is not a secret store,
and has no expiry — an expired OAuth2 token is not detected and not refreshed,
so a tool holding one has to clear it. A `pending` result needs a client that
can resume; nothing happens until the application reads the parked auth request
and starts a new run.

`ServiceAccountCredentialExchanger` ignores `tokenUri`, because
`google-auth-library` hardcodes `https://oauth2.googleapis.com/token` as both
the audience claim and the target, so a key file naming a different endpoint
still reaches Google's; adk-python honours the field. `privateKeyId` reaches the
JWT client as `keyId` and is not forwarded to the signer, so it does not become
the `kid` header. `useIdToken` and `audience` exist on `ServiceAccount` and are
not read, so a caller setting `useIdToken: true` receives an access token, not
an ID token. The exchanger is not exported from `@google/adk`, so a custom
exchanger cannot delegate to it; `OAuth2CredentialExchanger` is exported and can
be.

`openidUrlToSchemeCredential` uses the URL exactly as given, with no check on
scheme or host, matching adk-python. A caller that accepts the URL from a user,
a model or configuration it does not control should validate it first, because
the helper turns that value into an outbound request.

**Shipped but unreached.** Three pieces have no caller inside adk-js and exist
for parity or for your own code. `credentialToParam` builds the synthesized
parameter form that adk-python's `rest_api_tool.py` consumes, while adk-js
applies the credential to the request directly. `BaseAuthCredentialExchanger`
is subclassed by nothing here. `OAuth2BearerExchanger` reformats an OAuth2
access token into an HTTP bearer credential, but `ToolAuthHandler` routes an
OAuth2 credential to `OAuth2CredentialExchanger` in `core/src/auth/oauth2/` —
the class that fetches tokens, not the one that converts them — so a caller
wanting the bearer conversion in a request path performs it explicitly.
`AutoAuthCredentialExchanger` is likewise constructed with no arguments by
`ToolAuthHandler`, so `customExchangers` applies where your own code constructs
it.

## Related samples

- [OpenAPI tool](../../../../samples/tools/openapi_tool/README.md) - One spec becoming a toolset, one tool selected out of it by name, and an authenticated call.
- [Tool samples](../../../../samples/tools/README.md) - The category the sample lives in, and what CI does and does not run for it.
