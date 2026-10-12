/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {toSnakeCaseName} from '../../utils/case_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';
import {APIHubClient, BaseAPIHubClient} from './clients/apihub_client.js';

/** Options for {@link APIHubToolset}. */
export interface APIHubToolsetOptions {
  /**
   * The API Hub resource to build tools from. It must name an API, and may
   * also name a version and a spec, for example
   * `projects/my-project/locations/us-central1/apis/my-api`. An API Hub
   * console URL is also accepted.
   *
   * When it names a spec, that spec is used. Otherwise the first spec of the
   * named version, or of the first version of the named API, is used.
   */
  apihubResourceName: string;
  /**
   * An OAuth access token for API Hub, for example the output of
   * `gcloud auth print-access-token`. Ignored when `apihubClient` is set.
   */
  accessToken?: string;
  /**
   * The content of a service account key file, as a JSON string, used to
   * authenticate to API Hub when `accessToken` is not set. Ignored when
   * `apihubClient` is set.
   */
  serviceAccountJson?: string;
  /**
   * The toolset name. When empty, it is set from the spec's `info.title` in
   * snake_case, or `unnamed` when the spec has no title.
   */
  name?: string;
  /**
   * The toolset description. When empty, it is set from the spec's
   * `info.description`.
   */
  description?: string;
  /**
   * When true, the spec is fetched on the first call to `getTools` or
   * `getTool` instead of when the toolset is constructed.
   */
  lazyLoadSpec?: boolean;
  /** Auth scheme applied to every tool the spec produces. */
  authScheme?: OpenAPIV3.SecuritySchemeObject;
  /** Auth credential applied to every tool the spec produces. */
  authCredential?: AuthCredential;
  /**
   * The client that fetches the spec. Defaults to an {@link APIHubClient}
   * built from `accessToken` and `serviceAccountJson`.
   */
  apihubClient?: BaseAPIHubClient;
}

/**
 * Builds one tool per operation of an API registered in API Hub.
 *
 * The toolset fetches an OpenAPI spec from API Hub, parses it as YAML or JSON,
 * and hands it to an {@link OpenAPIToolset}, which produces a
 * {@link RestApiTool} for each operation.
 *
 * ```ts
 * const toolset = new APIHubToolset({
 *   apihubResourceName:
 *     'projects/my-project/locations/us-central1/apis/my-api',
 * });
 * const agent = new LlmAgent({
 *   name: 'api_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [toolset],
 * });
 * ```
 *
 * By default the spec is fetched when the toolset is constructed. A
 * constructor cannot wait for the request, so a failure is reported by the
 * first call to `getTools` or `getTool`, and every later call reports the same
 * failure.
 *
 * With `lazyLoadSpec`, the spec is fetched on the first call to `getTools` or
 * `getTool`. A successful result is kept, including a spec that produced no
 * tools. A failed fetch is not kept, so the next call fetches again.
 */
@experimental
export class APIHubToolset extends BaseToolset {
  /** The toolset name, filled in from the spec when empty. */
  name: string;
  /** The toolset description, filled in from the spec when empty. */
  description: string;
  readonly apihubResourceName: string;
  readonly lazyLoadSpec: boolean;

  private readonly apihubClient: BaseAPIHubClient;
  private readonly authScheme?: OpenAPIV3.SecuritySchemeObject;
  private readonly authCredential?: AuthCredential;
  private toolsetPromise?: Promise<OpenAPIToolset | undefined>;

  constructor(options: APIHubToolsetOptions) {
    super([]);
    this.name = options.name ?? '';
    this.description = options.description ?? '';
    this.apihubResourceName = options.apihubResourceName;
    this.lazyLoadSpec = options.lazyLoadSpec ?? false;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
    this.apihubClient =
      options.apihubClient ??
      new APIHubClient({
        accessToken: options.accessToken,
        serviceAccountJson: options.serviceAccountJson,
      });

    if (!this.lazyLoadSpec) {
      this.toolsetPromise = this.prepareTools();
      // The rejection is observed by `getTools` and `getTool`. Until one of
      // them runs, this handler keeps it from being reported as unhandled.
      this.toolsetPromise.catch(() => undefined);
    }
  }

  /**
   * Returns one tool per operation in the spec, or an empty array when the
   * spec is empty.
   *
   * @throws When the spec cannot be fetched or is not valid YAML or JSON.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const toolset = await this.loadToolset();
    return toolset ? toolset.getTools(context) : [];
  }

  /**
   * Returns the tool with the given name, or `undefined` when the spec
   * produced no such tool.
   *
   * Unlike `OpenAPIToolset.getTool`, the result is a Promise, because the spec
   * may still be loading.
   *
   * @param name The tool name, which is the operation ID in snake_case.
   * @throws When the spec cannot be fetched or is not valid YAML or JSON.
   */
  async getTool(name: string): Promise<RestApiTool | undefined> {
    const toolset = await this.loadToolset();
    return toolset?.getTool(name);
  }

  override async close(): Promise<void> {}

  private loadToolset(): Promise<OpenAPIToolset | undefined> {
    if (!this.toolsetPromise) {
      const promise = this.prepareTools();
      this.toolsetPromise = promise;
      promise.catch(() => {
        if (this.toolsetPromise === promise) {
          this.toolsetPromise = undefined;
        }
      });
    }
    return this.toolsetPromise;
  }

  private async prepareTools(): Promise<OpenAPIToolset | undefined> {
    const spec = await this.apihubClient.getSpecContent(
      this.apihubResourceName,
    );
    const specDict = yaml.load(spec) as OpenAPIV3.Document | undefined;
    if (!specDict) {
      return undefined;
    }

    this.name ||= toSnakeCaseName(specDict.info?.title ?? 'unnamed');
    this.description ||= specDict.info?.description ?? '';

    return new OpenAPIToolset({
      specDict,
      authScheme: this.authScheme,
      authCredential: this.authCredential,
    });
  }
}
