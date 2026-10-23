/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Describes where the agent runs, as an OpenTelemetry `Resource`.
 *
 * {@link buildGcpResource} merges one resource per source of truth, in
 * precedence order, each built by its own function:
 *
 *   1. `commonResource` - what is true of every deployment.
 *   2. `agentRuntimeResource` - the Agent Runtime (Agent Engine) deployment.
 *   3. `otelDetectedResource` - what the operator stated through
 *      `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`.
 *   4. `gcpDetectedResource` - what the platform says it is: GKE, Cloud Run,
 *      GCE, App Engine.
 *   5. `urnEnrichedResource` - the Agent Registry URN naming whatever the four
 *      above turned out to describe.
 *
 * Each may be empty, so merging it is a no-op. A source that has nothing to
 * say because this is not its platform says so at debug level; one that
 * should have had something and did not warns.
 */

import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

import type {AttributeValue} from '@opentelemetry/api';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
  type Resource,
} from '@opentelemetry/resources';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';

import {readNonEmptyEnvVar} from './env.js';
import {CLOUD_PLATFORM_SCOPE} from './gcp_logging.js';

/** Resource attribute keys this module reads or writes. */
enum ResourceAttr {
  CLOUD_ACCOUNT_ID = 'cloud.account.id',
  CLOUD_AVAILABILITY_ZONE = 'cloud.availability_zone',
  CLOUD_PLATFORM = 'cloud.platform',
  CLOUD_PROVIDER = 'cloud.provider',
  CLOUD_REGION = 'cloud.region',
  CLOUD_RESOURCE_ID = 'cloud.resource_id',
  FAAS_NAME = 'faas.name',
  GCP_PROJECT_ID = 'gcp.project_id',
  K8S_CLUSTER_NAME = 'k8s.cluster.name',
  K8S_DEPLOYMENT_NAME = 'k8s.deployment.name',
  K8S_NAMESPACE_NAME = 'k8s.namespace.name',
  MAIN_AGENT_ID = 'gen_ai.main_agent.id',
  SERVICE_INSTANCE_ID = 'service.instance.id',
  SERVICE_NAME = 'service.name',
  SERVICE_VERSION = 'service.version',
}

/** `cloud.platform` values the URN is built for. */
enum CloudPlatform {
  AGENT_ENGINE = 'gcp.agent_engine',
  KUBERNETES_ENGINE = 'gcp_kubernetes_engine',
  CLOUD_RUN = 'gcp_cloud_run',
}

/**
 * Kubernetes names a Deployment's pods `<deployment>-<replicaset hash>-<pod
 * hash>`, and tells the container only the pod name.
 */
const POD_NAME_HASHES = /-[a-z0-9]+-[a-z0-9]{5}$/;
const K8S_NAMESPACE_PATH =
  '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

/**
 * How many projects one process may hold resolved identifiers for: a ceiling
 * against unbounded growth rather than a size anyone should reach.
 */
const PROJECT_CACHE_SIZE = 32;

/** Characters a project ID or number may contain, legacy domain IDs included. */
const PROJECT_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const RESOURCE_MANAGER_PROJECTS_URL =
  'https://cloudresourcemanager.googleapis.com/v3/projects/';

/** The two identifiers of a project, neither `projects/`-prefixed. */
export interface GcpProject {
  /** The project ID, or empty when it could not be determined. */
  readonly id: string;
  /** The project number, or empty when it could not be determined. */
  readonly number: string;
}

/** The part of `GoogleAuth` a project lookup uses. */
export interface ProjectLookupAuth {
  request(opts: {url: string; method: 'GET'}): Promise<{data: unknown}>;
}

/** Successful lookups, oldest first. */
const projectCache = new Map<string, GcpProject>();
/** Lookups in flight, so concurrent callers share one request. */
const projectLookups = new Map<string, Promise<GcpProject>>();

let defaultAuth: GoogleAuth | undefined;

/** Returns a resource attribute, or empty if it is absent or not a string. */
function strAttr(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
  key: string,
): string {
  const value = attributes[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Returns both identifiers of a project, given either one of them.
 *
 * Best effort. A project ID passed in is always returned; the number only ever
 * comes from Cloud Resource Manager, so it is empty whenever that lookup
 * fails. Only successful lookups are memoized, so a failure at startup costs
 * one incomplete answer rather than one for the life of the process.
 *
 * @param project The project ID or project number.
 * @param auth Credentials for the lookup. Application Default Credentials are
 *     used when omitted.
 */
export async function fetchProject(
  project: string | undefined,
  auth?: ProjectLookupAuth,
): Promise<GcpProject> {
  if (!project) {
    return {id: '', number: ''};
  }
  const cached = projectCache.get(project);
  if (cached) {
    return cached;
  }
  let lookup = projectLookups.get(project);
  if (!lookup) {
    lookup = lookUpProject(project, auth);
    projectLookups.set(project, lookup);
    // The entry goes either way: a success moves to the cache, and a failure
    // must not be remembered.
    void lookup.finally(() => projectLookups.delete(project));
  }
  return lookup;
}

function cacheProject(key: string, resolved: GcpProject): void {
  if (!projectCache.has(key) && projectCache.size >= PROJECT_CACHE_SIZE) {
    // Evict the oldest rather than clear: a process this busy is redirecting
    // telemetry per request, and the project it started with is the one it
    // is least likely to need next.
    const oldest = projectCache.keys().next();
    if (!oldest.done) {
      projectCache.delete(oldest.value);
    }
  }
  projectCache.set(key, resolved);
}

async function lookUpProject(
  project: string,
  auth: ProjectLookupAuth | undefined,
): Promise<GcpProject> {
  // Only the lookup tells a number from one of the legacy project IDs that
  // are all digits, so a failure leaves the number unknown rather than
  // reading digits as one.
  const known: GcpProject = {
    id: /^\d+$/.test(project) ? '' : project,
    number: '',
  };
  try {
    if (!PROJECT_PATTERN.test(project)) {
      throw new Error('The project is not a valid project ID or number.');
    }
    const client =
      auth ??
      (defaultAuth ??= new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]}));
    const {data} = await client.request({
      url: RESOURCE_MANAGER_PROJECTS_URL + encodeURIComponent(project),
      method: 'GET',
    });
    const isObject = typeof data === 'object' && data !== null;
    const projectId =
      isObject && 'projectId' in data ? data.projectId : undefined;
    const name = isObject && 'name' in data ? data.name : undefined;
    // `name` is `projects/<number>`.
    const number = typeof name === 'string' ? name.split('/')[1] : undefined;
    if (typeof projectId !== 'string' || !projectId || !number) {
      throw new Error(
        'Cloud Resource Manager returned no project identifiers.',
      );
    }
    const resolved: GcpProject = {id: projectId, number};
    cacheProject(project, resolved);
    if (resolved.id !== project) {
      cacheProject(resolved.id, resolved);
    }
    return resolved;
  } catch {
    logger.warn(
      "Failed to look up the project's other identifier. Your traces and " +
        'logs may not be associated, and the agent URN may be incomplete. To ' +
        'fix this, consider enabling the Cloud Resource Manager API and ' +
        'redeploying your agent.',
    );
    return known;
  }
}

/** Returns what holds for every deployment, on any platform. */
function commonResource(projectId: string | undefined): Resource {
  const attributes: Record<string, AttributeValue> = {
    // Unique per process, so two replicas of one deployment stay
    // distinguishable after every other attribute has turned out identical.
    [ResourceAttr.SERVICE_INSTANCE_ID]: `${randomUUID().replaceAll('-', '')}-${process.pid}`,
  };
  if (projectId) {
    attributes[ResourceAttr.GCP_PROJECT_ID] = projectId;
    attributes[ResourceAttr.CLOUD_ACCOUNT_ID] = projectId;
  } else {
    logger.warn(
      'No project could be determined, so telemetry will not name one. Set ' +
        'GOOGLE_CLOUD_PROJECT, or pass a project explicitly, if it should.',
    );
  }
  return resourceFromAttributes(attributes);
}

/** Returns the resource describing an Agent Runtime deployment, if this is one. */
function agentRuntimeResource(projectId: string | undefined): Resource {
  const agentEngineId = readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_ID');
  if (!agentEngineId) {
    logger.debug('Not on Agent Runtime; no deployment of its own to describe.');
    return resourceFromAttributes({});
  }
  const location =
    readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION') ??
    readNonEmptyEnvVar('GOOGLE_CLOUD_LOCATION');
  if (!location) {
    logger.warn(
      'On Agent Runtime with no location set, so this deployment cannot be ' +
        'named. Set GOOGLE_CLOUD_AGENT_ENGINE_LOCATION or ' +
        'GOOGLE_CLOUD_LOCATION.',
    );
  }
  const attributes: Record<string, AttributeValue> = {
    [ResourceAttr.CLOUD_PROVIDER]: 'gcp',
    [ResourceAttr.CLOUD_PLATFORM]: CloudPlatform.AGENT_ENGINE,
    [ResourceAttr.SERVICE_NAME]: agentEngineId,
    [ResourceAttr.SERVICE_VERSION]:
      process.env['GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID'] ?? '',
    [ResourceAttr.CLOUD_REGION]: location ?? '',
  };
  if (projectId && location) {
    attributes[ResourceAttr.CLOUD_RESOURCE_ID] =
      `//aiplatform.googleapis.com/projects/${projectId}` +
      `/locations/${location}/reasoningEngines/${agentEngineId}`;
  }
  // Built on the default resource, for the `telemetry.sdk.*` attributes the
  // Agent Runtime resource has always carried.
  return defaultResource().merge(resourceFromAttributes(attributes));
}

/** Returns what the operator declared through the OTel environment. */
function otelDetectedResource(): Resource {
  return detectResources({detectors: [envDetector]});
}

/**
 * Returns the resource the GCP detector describes this platform with. Empty on
 * Agent Runtime, where the detector would describe the infrastructure
 * underneath the deployment and, merging last, bury the deployment itself.
 */
function gcpDetectedResource(): Resource {
  if (readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_ID')) {
    return resourceFromAttributes({});
  }
  return detectResources({detectors: [gcpDetector]});
}

/** Returns where the agent is deployed: a zone, or failing that a region. */
function urnLocationSegment(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): string {
  const zone = strAttr(attributes, ResourceAttr.CLOUD_AVAILABILITY_ZONE);
  if (zone) {
    return `zones:${zone}`;
  }
  const region = strAttr(attributes, ResourceAttr.CLOUD_REGION);
  return region ? `locations:${region}` : '';
}

/** Returns the namespace this pod runs in, per its service account token. */
async function k8sNamespace(): Promise<string> {
  try {
    return (await readFile(K8S_NAMESPACE_PATH, 'utf-8')).trim();
  } catch {
    logger.debug('This pod has no service account namespace to read.');
    return '';
  }
}

/** Returns the Deployment this pod belongs to, read off the pod name. */
function k8sDeployment(): string {
  const hostname = process.env['HOSTNAME'] ?? '';
  if (!POD_NAME_HASHES.test(hostname)) {
    logger.debug('HOSTNAME is not a name a Deployment would have given a pod.');
    return '';
  }
  return hostname.replace(POD_NAME_HASHES, '');
}

/** Returns the segments naming a GKE Deployment, or empty if one is unknown. */
async function urnGkeSegment(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): Promise<string> {
  const cluster = strAttr(attributes, ResourceAttr.K8S_CLUSTER_NAME);
  // The GCP detector reports the cluster but neither the namespace nor the
  // Deployment, so those fall back to what the pod itself can say.
  const statedNamespace = strAttr(attributes, ResourceAttr.K8S_NAMESPACE_NAME);
  const namespace = statedNamespace ? statedNamespace : await k8sNamespace();
  const statedDeployment = strAttr(
    attributes,
    ResourceAttr.K8S_DEPLOYMENT_NAME,
  );
  const deployment = statedDeployment ? statedDeployment : k8sDeployment();
  const segments: Array<[string, string, ResourceAttr]> = [
    ['cluster', cluster, ResourceAttr.K8S_CLUSTER_NAME],
    ['namespace', namespace, ResourceAttr.K8S_NAMESPACE_NAME],
    ['Deployment', deployment, ResourceAttr.K8S_DEPLOYMENT_NAME],
  ];
  for (const [what, value, attribute] of segments) {
    if (!value) {
      logger.warn(
        `The GKE ${what} is unknown, so no agent URN is set. Set ${attribute} ` +
          'in OTEL_RESOURCE_ATTRIBUTES to state it.',
      );
    }
  }
  if (!cluster || !namespace || !deployment) {
    return '';
  }
  return (
    `container:clusters:${cluster}` +
    `:k8s:namespaces:${namespace}` +
    `:apps:deployments:${deployment}`
  );
}

/**
 * Returns the segments naming the workload, empty if part of it is unknown,
 * or undefined on a platform Agent Registry names no agent on.
 */
async function urnWorkloadSegment(
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): Promise<string | undefined> {
  const platform = strAttr(attributes, ResourceAttr.CLOUD_PLATFORM);
  switch (platform) {
    case CloudPlatform.AGENT_ENGINE: {
      // Read the Reasoning Engine ID from the environment first so
      // `OTEL_SERVICE_NAME` overriding `service.name` does not replace the
      // instance ID in the URN.
      const agentEngineId =
        readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_ID') ??
        strAttr(attributes, ResourceAttr.SERVICE_NAME);
      if (!agentEngineId) {
        logger.warn(
          'The Agent Runtime instance ID is unknown, so no agent URN is set.',
        );
        return '';
      }
      return `aiplatform:reasoningEngines:${agentEngineId}`;
    }
    case CloudPlatform.KUBERNETES_ENGINE:
      return urnGkeSegment(attributes);
    case CloudPlatform.CLOUD_RUN: {
      const service = strAttr(attributes, ResourceAttr.FAAS_NAME);
      if (!service) {
        logger.warn(
          'The Cloud Run service name is unknown, so no agent URN is set.',
        );
        return '';
      }
      return `run:services:${service}`;
    }
    default:
      logger.debug(
        `Agent Registry names no agent on ${platform ? platform : 'this platform'}, so there is no URN to build.`,
      );
      return undefined;
  }
}

/**
 * Returns the Agent Registry URN for the deployment `resource` describes, or
 * undefined when no complete URN can be built. Never rejects.
 *
 * All or nothing: a URN missing a segment would join to the wrong agent, so a
 * segment that could not be detected is warned about and no URN is emitted.
 */
async function agentUrn(resource: Resource): Promise<string | undefined> {
  try {
    await resource.waitForAsyncAttributes?.();
    const attributes = resource.attributes;
    if (Object.hasOwn(attributes, ResourceAttr.MAIN_AGENT_ID)) {
      logger.debug('The URN is already set; leaving it as it is.');
      return undefined;
    }
    const workload = await urnWorkloadSegment(attributes);
    if (!workload) {
      return undefined;
    }
    const projectId = strAttr(attributes, ResourceAttr.CLOUD_ACCOUNT_ID);
    const {number} = await fetchProject(projectId);
    if (!number) {
      logger.warn(
        `The number of project '${projectId}' is unknown, so no agent URN is set.`,
      );
      return undefined;
    }
    const location = urnLocationSegment(attributes);
    if (!location) {
      logger.warn(
        'Neither a zone nor a region could be detected, so no agent URN is set.',
      );
      return undefined;
    }
    return [
      'urn:agent',
      `projects-${number}`,
      `projects:${number}`,
      location,
      workload,
    ].join(':');
  } catch {
    logger.warn('Failed to build the agent URN, so no agent URN is set.');
    return undefined;
  }
}

/**
 * Returns the resource carrying the agent URN of the deployment `resource`
 * describes. The value settles asynchronously; when no URN can be built it
 * resolves to undefined, and merging keeps any earlier value.
 */
function urnEnrichedResource(resource: Resource): Resource {
  return resourceFromAttributes({
    [ResourceAttr.MAIN_AGENT_ID]: agentUrn(resource),
  });
}

/**
 * Returns the OTel resource describing this deployment.
 *
 * Later sources win: the platform's own answer overrides what the operator
 * configured, which overrides the defaults. The resource is never empty: it
 * always carries at least a service instance.
 *
 * @param projectId The project telemetry is reported to. Falls back to
 *     `GOOGLE_CLOUD_PROJECT` when omitted.
 */
export function buildGcpResource(projectId?: string): Resource {
  const resolvedProjectId =
    projectId || readNonEmptyEnvVar('GOOGLE_CLOUD_PROJECT');
  const resource = commonResource(resolvedProjectId)
    .merge(agentRuntimeResource(resolvedProjectId))
    .merge(otelDetectedResource())
    .merge(gcpDetectedResource());
  // Enrichment reads the four above, so it has to see the merged result.
  return resource.merge(urnEnrichedResource(resource));
}
