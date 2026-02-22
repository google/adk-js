# CLI Reference

The `@google/adk-devtools` package provides a comprehensive CLI for developing, testing, and deploying ADK-JS agents.

## Installation

```bash
npm install @google/adk-devtools
```

The CLI is available as:
```bash
npx @google/adk-devtools <command>
```

## Commands Overview

The CLI provides five main commands:

| Command | Purpose |
|---------|---------|
| `web` | Start ADK web server with debug UI |
| `api_server` | Start ADK API server (no UI) |
| `create` | Scaffold a new agent project |
| `run` | Run an agent interactively in the terminal |
| `deploy cloud_run` | Deploy an agent to Google Cloud Run |

## Common Options

These options are available across multiple commands:

### Logging Options

| Option | Description | Default |
|--------|-------------|---------|
| `-v, --verbose [boolean]` | Enable verbose/debug logging | `false` |
| `--log_level <string>` | Set log level: debug, info, warn, error | `info` |

### Service URIs

| Option | Description | Default |
|--------|-------------|---------|
| `--session_service_uri <string>` | Session service URI (e.g., `memory://`) | `memory://` |
| `--artifact_service_uri <string>` | Artifact service URI (e.g., `gs://bucket-name`, `memory://`) | `memory://` |

### Agent File Options

| Option | Description | Default |
|--------|-------------|---------|
| `--compile [boolean]` | Compile TypeScript agent files to JavaScript | `true` |
| `--bundle [boolean]` | Bundle agent file with dependencies | `true` |
| `--file_type <string>` | Module type: `esm` or `cjs` | Auto-detected |

### Telemetry Options

| Option | Description | Default |
|--------|-------------|---------|
| `--otel_to_cloud [boolean]` | Send OpenTelemetry traces to Google Cloud | `false` |

## web Command

Start the ADK web server with an interactive debug UI.

### Syntax

```bash
npx @google/adk-devtools web [agents_dir] [options]
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `[agents_dir]` | Agent file or directory | Current working directory |

### Options

In addition to common options:

| Option | Description | Default |
|--------|-------------|---------|
| `-h, --host <string>` | Server binding host | System hostname |
| `-p, --port <number>` | Server port | `8000` |
| `--allow_origins <string>` | CORS allowed origins | `""` (none) |

### Agent Directory Structure

The `agents_dir` can be:

1. **A single agent file:**
   ```
   my_agent.ts
   ```

2. **A directory with multiple agent files:**
   ```
   agents/
   ├── agent1.ts
   ├── agent2.js
   └── agent3.mjs
   ```

3. **A directory with agent subdirectories:**
   ```
   agents/
   ├── customer_support/
   │   └── agent.ts
   ├── sales/
   │   └── agent.js
   └── analytics/
       └── agent.ts
   ```

### Agent File Requirements

Each agent file must export a `BaseAgent` instance:

```typescript
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'my_agent',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant.'
});
```

Alternatively, export as default:

```typescript
export default new LlmAgent({
  name: 'my_agent',
  model: 'gemini-2.5-flash'
});
```

### Examples

**Start server with TypeScript agents:**
```bash
npx @google/adk-devtools web ./agents --port 8080
```

**Start with verbose logging:**
```bash
npx @google/adk-devtools web --verbose
```

**Enable telemetry to Google Cloud:**
```bash
npx @google/adk-devtools web --otel_to_cloud true
```

**Configure CORS:**
```bash
npx @google/adk-devtools web --allow_origins "http://localhost:3000"
```

**Use GCS for artifacts:**
```bash
npx @google/adk-devtools web --artifact_service_uri gs://my-bucket
```

### Accessing the UI

Once started, the server displays:
```
+-----------------------------------------------------------------------------+
| ADK Web Server started                                                      |
|                                                                             |
| For local testing, access at http://hostname:8000.                         |
+-----------------------------------------------------------------------------+
```

Navigate to `http://hostname:8000` to access the debug UI.

## api_server Command

Start the ADK API server without the debug UI (production mode).

### Syntax

```bash
npx @google/adk-devtools api_server [agents_dir] [options]
```

### Arguments and Options

Same as the `web` command. The only difference is that `serveDebugUI` is set to `false`.

### Example

```bash
npx @google/adk-devtools api_server ./agents --port 8080
```

This exposes only the REST API endpoints without serving the Angular debug UI.

## create Command

Scaffold a new agent project with interactive prompts.

### Syntax

```bash
npx @google/adk-devtools create [agent] [options]
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `[agent]` | Name for the new agent project | `adk_agent` |

### Options

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompts (use defaults) |
| `--model <string>` | Model for the root agent |
| `--api_key <string>` | Google AI API Key |
| `--project <string>` | Google Cloud Project (for Vertex AI) |
| `--region <string>` | Google Cloud Region (for Vertex AI) |
| `--language <string>` | Language: `ts` or `js` |

### Interactive Prompts

If options are not provided, the CLI prompts for:

1. **Model selection:**
   - `gemini-2.5-flash`
   - `gemini-2.5-pro`
   - `gemini-3-flash-preview`
   - `gemini-3-pro-preview`

2. **Language:**
   - TypeScript
   - JavaScript

3. **Backend:**
   - Google AI (requires API key)
   - Vertex AI (requires project and region)

### Generated Files

The command creates a directory with:

```
agent_name/
├── agent.ts (or agent.js)
├── .env
├── package.json
└── tsconfig.json (TypeScript only)
```

**agent.ts example:**

```typescript
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const getCurrentTime = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z.string().describe("The name of the city for which to retrieve the current time."),
  }),
  execute: ({city}) => {
    return {status: 'success', report: `The current time in ${city} is 10:30 AM`};
  },
});

export const rootAgent = new LlmAgent({
  name: 'hello_time_agent',
  model: 'gemini-2.5-flash',
  description: 'Tells the current time in a specified city.',
  instruction: `You are a helpful assistant that tells the current time in a city.
                Use the 'getCurrentTime' tool for this purpose.`,
  tools: [getCurrentTime],
});
```

**.env example:**

```bash
GOOGLE_API_KEY=your_api_key_here
GOOGLE_GENAI_USE_VERTEXAI=0
```

Or for Vertex AI:

```bash
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=1
```

**package.json includes scripts:**

```json
{
  "scripts": {
    "web": "npx @google/adk-devtools web",
    "cli": "npx @google/adk-devtools run agent.ts"
  }
}
```

### Examples

**Create with all defaults (non-interactive):**
```bash
npx @google/adk-devtools create my_agent -y
```

**Create with specific model:**
```bash
npx @google/adk-devtools create my_agent --model gemini-2.5-pro
```

**Create for Vertex AI:**
```bash
npx @google/adk-devtools create my_agent \
  --project my-gcp-project \
  --region us-central1
```

**Create in JavaScript:**
```bash
npx @google/adk-devtools create my_agent --language js
```

### Running the Created Agent

After creation:

```bash
cd my_agent
npm install
npm run web   # Start web server
# or
npm run cli   # Run in terminal
```

## run Command

Run an agent interactively in the terminal (CLI mode).

### Syntax

```bash
npx @google/adk-devtools run <agent> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<agent>` | Path to agent file (.js or .ts) |

### Options

In addition to common options:

| Option | Description | Default |
|--------|-------------|---------|
| `--save_session [boolean]` | Save session to JSON file on exit | `false` |
| `--session_id <string>` | Session ID for saved session | Prompted if needed |
| `--replay <string>` | Replay queries from JSON file | - |
| `--resume <string>` | Resume from saved session file | - |

### Interactive Mode

By default, the `run` command starts an interactive terminal session:

```bash
npx @google/adk-devtools run agent.ts
```

Output:
```
Running agent my_agent, type exit to exit.
[user]: Hello
[my_agent]: Hello! How can I help you today?
[user]: exit
```

Type `exit` to quit.

### Session Save

Save the session to a JSON file for later analysis or resumption:

```bash
npx @google/adk-devtools run agent.ts --save_session true
```

On exit, you'll be prompted for a session ID:
```
Session ID to save: demo_session
Session saved to agent.ts/demo_session.session.json
```

Provide session ID upfront:
```bash
npx @google/adk-devtools run agent.ts \
  --save_session true \
  --session_id demo_session
```

### Session Resume

Resume a previously saved session:

```bash
npx @google/adk-devtools run agent.ts \
  --resume demo_session.session.json
```

This:
1. Loads the saved session
2. Replays all previous events in the terminal
3. Allows you to continue the conversation interactively

### Session Replay

Replay a session from a JSON file (non-interactive):

**input.json:**
```json
{
  "state": {
    "user_name": "Alice",
    "user_tier": "premium"
  },
  "queries": [
    "What is my account status?",
    "Can you help me upgrade my plan?"
  ]
}
```

Run replay:
```bash
npx @google/adk-devtools run agent.ts --replay input.json
```

This:
1. Creates a new session with the provided state
2. Runs each query sequentially
3. Prints the conversation to the terminal
4. Exits when all queries are complete (non-interactive)

### Examples

**Basic interactive run:**
```bash
npx @google/adk-devtools run agent.ts
```

**Run with verbose logging:**
```bash
npx @google/adk-devtools run agent.ts --verbose
```

**Save session with custom ID:**
```bash
npx @google/adk-devtools run agent.ts \
  --save_session true \
  --session_id support_2024_01_15
```

**Resume previous session:**
```bash
npx @google/adk-devtools run agent.ts \
  --resume support_2024_01_15.session.json
```

**Replay queries for testing:**
```bash
npx @google/adk-devtools run agent.ts --replay test_cases.json
```

**Combine replay and save:**
```bash
npx @google/adk-devtools run agent.ts \
  --replay input.json \
  --save_session true \
  --session_id test_run_1
```

## deploy cloud_run Command

Deploy an agent to Google Cloud Run.

### Syntax

```bash
npx @google/adk-devtools deploy cloud_run [agents_dir] [options]
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `[agents_dir]` | Agent file or directory | Current working directory |

### Options

In addition to common options:

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <number>` | Server port | `8000` |
| `--project [string]` | Google Cloud project ID | gcloud default |
| `--region [string]` | Google Cloud region | gcloud default |
| `--service_name [string]` | Cloud Run service name | `adk-default-service-name` |
| `--temp_folder [string]` | Temp folder for build artifacts | System temp directory |
| `--adk_version [string]` | ADK version to use | `latest` |
| `--with_ui [boolean]` | Deploy with debug UI | `false` |
| `--allow_origins <string>` | CORS allowed origins | `""` |

### Additional gcloud Arguments

Any additional arguments are passed directly to `gcloud run deploy`:

```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --project my-project \
  --region us-central1 \
  --memory 2Gi \
  --cpu 2 \
  --max-instances 10
```

ADK manages these arguments automatically (do not override):
- `--source`
- `--project`
- `--port`
- `--verbosity`
- `--region` (if specified)

### Prerequisites

1. **gcloud CLI installed:**
   ```bash
   gcloud version
   ```

2. **Authenticated:**
   ```bash
   gcloud auth login
   ```

3. **Default project set (optional):**
   ```bash
   gcloud config set project my-project
   gcloud config set run/region us-central1
   ```

### Deployment Process

The command:

1. **Compiles agents** - Using esbuild with bundling
2. **Generates Dockerfile** - Creates container configuration
3. **Generates package.json** - With ADK dependencies
4. **Copies agent files** - To temporary build directory
5. **Runs gcloud deploy** - Builds and deploys to Cloud Run

### Generated Dockerfile

The CLI generates a Dockerfile similar to:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
CMD ["npx", "@google/adk-devtools", "api_server", "--port", "8000"]
```

### Examples

**Deploy to default project/region:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents
```

**Deploy with custom service name:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --service_name my-support-agent
```

**Deploy with debug UI:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --service_name my-agent \
  --with_ui true
```

**Deploy with specific resources:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --project my-project \
  --region us-central1 \
  --service_name my-agent \
  --memory 4Gi \
  --cpu 2 \
  --max-instances 20
```

**Deploy with GCS artifacts:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --service_name my-agent \
  --artifact_service_uri gs://my-agent-artifacts
```

**Deploy with telemetry:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --service_name my-agent \
  --otel_to_cloud true
```

**Deploy with environment variables:**
```bash
npx @google/adk-devtools deploy cloud_run ./agents \
  --service_name my-agent \
  --set-env-vars "API_KEY=secret,ENVIRONMENT=production"
```

### Post-Deployment

After successful deployment, gcloud outputs the service URL:

```
Service [my-agent] revision [my-agent-00001-abc] has been deployed and is serving 100 percent of traffic.
Service URL: https://my-agent-xxxxx-uc.a.run.app
```

Access the API:
```bash
curl https://my-agent-xxxxx-uc.a.run.app/list-apps
```

## AgentLoader

The `AgentLoader` class is used internally by the CLI to discover and load agents.

### Discovery Mechanism

**For a single file:**
- Load the file directly

**For a directory:**
- Scan for `*.js`, `*.ts`, `*.mjs`, `*.cjs`, `*.mts`, `*.cts` files
- For each subdirectory, check for `agent.js`, `agent.ts`, etc.

**Agent identification:**
- File must export a `BaseAgent` instance
- Checked via `isBaseAgent()` symbol-based type guard
- Can be exported as `rootAgent`, `default`, or any named export

### Module Type Detection

The loader automatically detects whether a file is ESM or CJS:

1. **Explicit extensions:**
   - `.mjs`, `.mts` → ESM
   - `.cjs`, `.cts` → CJS

2. **For `.js` and `.ts` files:**
   - Search for `package.json` in file directory
   - Check `"type"` field:
     - `"type": "module"` → ESM
     - `"type": "commonjs"` or not set → CJS
   - Traverse up directory tree until found or reach root

### Compilation with esbuild

When `--compile true` (default):

1. **Uses esbuild** to compile TypeScript to JavaScript
2. **Target:** `node16`
3. **Platform:** `node`
4. **Format:** Auto-detected (ESM or CJS)
5. **Output:** Temporary file in system temp directory

When `--bundle true` (default):

1. **Bundles** all dependencies into a single file
2. **Minifies** the output
3. **Uses shim plugin** for Node.js built-ins

The compiled file is automatically cleaned up when the process exits.

## ESM and CJS Support

The CLI fully supports both ECMAScript Modules (ESM) and CommonJS (CJS):

### ESM Example

```typescript
// agent.mjs or agent.ts with "type": "module"
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'esm_agent',
  model: 'gemini-2.5-flash'
});
```

### CJS Example

```javascript
// agent.cjs or agent.js with "type": "commonjs"
const {LlmAgent} = require('@google/adk');

module.exports = {
  rootAgent: new LlmAgent({
    name: 'cjs_agent',
    model: 'gemini-2.5-flash'
  })
};
```

### Mixed Environments

The loader handles mixed environments automatically. You can have both ESM and CJS agents in the same directory.

## Environment Variables

The CLI respects these environment variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Fallback for `--session_service_uri` |
| `ADK_LOG_LEVEL` | Default log level |
| `GOOGLE_API_KEY` | API key for Gemini API |
| `GOOGLE_GENAI_API_KEY` | Alternative API key variable |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID |
| `GOOGLE_CLOUD_LOCATION` | GCP region |
| `GOOGLE_GENAI_USE_VERTEXAI` | Use Vertex AI instead of Gemini API |
| `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` | Include content in traces |

See [Architecture](./architecture.md) for more details on environment variables.

## Complete Workflow Example

### 1. Create a new agent

```bash
npx @google/adk-devtools create support_agent \
  --model gemini-2.5-pro \
  --api_key $GOOGLE_API_KEY
```

### 2. Develop and test locally

```bash
cd support_agent
npm install

# Test in terminal
npx @google/adk-devtools run agent.ts

# Start web UI for visual development
npx @google/adk-devtools web --verbose
```

### 3. Test with saved sessions

```bash
# Save a test session
npx @google/adk-devtools run agent.ts \
  --save_session true \
  --session_id test_1

# Replay for regression testing
npx @google/adk-devtools run agent.ts \
  --replay test_cases.json
```

### 4. Deploy to Cloud Run

```bash
npx @google/adk-devtools deploy cloud_run . \
  --project my-gcp-project \
  --region us-central1 \
  --service_name support-agent-prod \
  --otel_to_cloud true \
  --memory 2Gi \
  --max-instances 10
```

## Related Documentation

- [Architecture](./architecture.md) - System overview
- [Agents](./agents.md) - Agent types and configuration
- [Runner](./runner.md) - Execution orchestration
- [API Reference](./api-reference.md) - REST API endpoints
- [Telemetry](./telemetry.md) - OpenTelemetry integration
