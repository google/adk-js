/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Resource} from '@opentelemetry/resources';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  buildGcpResource,
  fetchProject,
} from '../../src/telemetry/gcp_resource.js';
import {getGcpResource} from '../../src/telemetry/google_cloud.js';
import {logger} from '../../src/utils/logger.js';

const state = vi.hoisted(() => ({
  detectedAttributes: {} as Record<string, string>,
  detectCalls: 0,
  namespaceFile: undefined as string | undefined,
  projectNumbers: {} as Record<string, string>,
  lookups: [] as string[],
}));

vi.mock('@opentelemetry/resource-detector-gcp', () => ({
  gcpDetector: {
    detect: () => {
      state.detectCalls++;
      return {attributes: {...state.detectedAttributes}};
    },
  },
}));

vi.mock('google-auth-library', async (importOriginal) => {
  const original = await importOriginal<typeof import('google-auth-library')>();
  class FakeGoogleAuth {
    async request(opts: {url: string}): Promise<{data: unknown}> {
      state.lookups.push(opts.url);
      const project = decodeURIComponent(opts.url.split('/').pop() ?? '');
      const number = state.projectNumbers[project];
      if (!number) {
        throw new Error('Permission denied.');
      }
      return {data: {projectId: project, name: `projects/${number}`}};
    }
  }
  return {...original, GoogleAuth: FakeGoogleAuth};
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (
        args[0] === '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
      ) {
        if (state.namespaceFile === undefined) {
          throw new Error('ENOENT');
        }
        return state.namespaceFile;
      }
      return original.readFile(...args);
    },
  };
});

const ENV_VARS = [
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SERVICE_NAME',
  'HOSTNAME',
];

const GKE_ATTRIBUTES = {
  'cloud.provider': 'gcp',
  'cloud.platform': 'gcp_kubernetes_engine',
  'cloud.account.id': 'urn-project',
  'cloud.region': 'us-central1',
  'k8s.cluster.name': 'my-cluster',
};

const CLOUD_RUN_ATTRIBUTES = {
  'cloud.provider': 'gcp',
  'cloud.platform': 'gcp_cloud_run',
  'cloud.account.id': 'urn-project',
  'cloud.region': 'us-central1',
  'faas.name': 'my-agent',
};

async function settledAttributes(
  resource: Resource,
): Promise<Resource['attributes']> {
  await resource.waitForAsyncAttributes?.();
  return resource.attributes;
}

describe('getGcpResource', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const name of ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
    state.detectedAttributes = {};
    state.detectCalls = 0;
    state.namespaceFile = undefined;
    state.projectNumbers = {'urn-project': '987654321'};
    state.lookups.length = 0;
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('common layer', () => {
    it('names a per-process service instance and the project', async () => {
      const first = await settledAttributes(getGcpResource('my-project'));
      const second = await settledAttributes(getGcpResource('my-project'));

      expect(first['service.instance.id']).toMatch(
        new RegExp(`^[0-9a-f]{32}-${process.pid}$`),
      );
      expect(first['service.instance.id']).not.toBe(
        second['service.instance.id'],
      );
      expect(first['gcp.project_id']).toBe('my-project');
      expect(first['cloud.account.id']).toBe('my-project');
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to GOOGLE_CLOUD_PROJECT when no project is passed', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-default-project');

      const attributes = await settledAttributes(getGcpResource());

      expect(attributes['gcp.project_id']).toBe('env-default-project');
      expect(attributes['cloud.account.id']).toBe('env-default-project');
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns and names no project when none is given', async () => {
      const attributes = await settledAttributes(getGcpResource());

      expect(attributes).not.toHaveProperty('gcp.project_id');
      expect(attributes).not.toHaveProperty('cloud.account.id');
      expect(attributes['service.instance.id']).toEqual(expect.any(String));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('No project could be determined'),
      );
    });
  });

  describe('precedence', () => {
    it('lets the OTel environment override the common layer', async () => {
      vi.stubEnv(
        'OTEL_RESOURCE_ATTRIBUTES',
        'gcp.project_id=env-project,k8s.namespace.name=prod',
      );
      vi.stubEnv('OTEL_SERVICE_NAME', 'env-service');

      const attributes = await settledAttributes(getGcpResource('my-project'));

      expect(attributes['gcp.project_id']).toBe('env-project');
      expect(attributes['k8s.namespace.name']).toBe('prod');
      expect(attributes['service.name']).toBe('env-service');
    });

    it('lets the GCP detector override the OTel environment', async () => {
      vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'cloud.account.id=env-project');
      state.detectedAttributes = {
        'cloud.platform': 'gcp_compute_engine',
        'cloud.account.id': 'detected-project',
      };

      const attributes = await settledAttributes(getGcpResource('my-project'));

      expect(attributes['cloud.account.id']).toBe('detected-project');
      expect(attributes['gcp.project_id']).toBe('my-project');
    });
  });

  describe('on Agent Engine', () => {
    beforeEach(() => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', '1234567890');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID', 'rev-7');
    });

    it('describes the deployment and skips the GCP detector', async () => {
      state.projectNumbers['my-project'] = '123456789';

      const attributes = await settledAttributes(getGcpResource('my-project'));

      expect(attributes).toMatchObject({
        'cloud.provider': 'gcp',
        'cloud.platform': 'gcp.agent_engine',
        'service.name': '1234567890',
        'service.version': 'rev-7',
        'cloud.region': 'us-central1',
        'cloud.resource_id':
          '//aiplatform.googleapis.com/projects/my-project/locations/us-central1/reasoningEngines/1234567890',
        'telemetry.sdk.language': 'nodejs',
        'telemetry.sdk.name': 'opentelemetry',
        'gcp.project_id': 'my-project',
        'gen_ai.main_agent.id':
          'urn:agent:projects-123456789:projects:123456789:locations:us-central1:aiplatform:reasoningEngines:1234567890',
      });
      expect(state.detectCalls).toBe(0);
    });

    it('prefers GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', async () => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', 'europe-west4');

      const attributes = await settledAttributes(getGcpResource('my-project'));

      expect(attributes['cloud.region']).toBe('europe-west4');
    });

    it('warns and names no resource or URN without a location', async () => {
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
      state.projectNumbers['my-project'] = '123456789';

      const attributes = await settledAttributes(getGcpResource('my-project'));

      expect(attributes['cloud.region']).toBe('');
      expect(attributes).not.toHaveProperty('cloud.resource_id');
      expect(attributes).not.toHaveProperty('gen_ai.main_agent.id');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('On Agent Runtime with no location set'),
      );
    });

    it('never puts an unresolved project number in the URN', async () => {
      const attributes = await settledAttributes(getGcpResource('123000123'));

      expect(attributes).not.toHaveProperty('gen_ai.main_agent.id');
      expect(attributes['gcp.project_id']).toBe('123000123');
    });

    it('keeps the Reasoning Engine ID in the URN when OTEL_SERVICE_NAME overrides service.name', async () => {
      state.projectNumbers['my-project'] = '123456789';
      vi.stubEnv('OTEL_SERVICE_NAME', 'my-custom-service');

      const attributes = await settledAttributes(getGcpResource('my-project'));

      expect(attributes['service.name']).toBe('my-custom-service');
      expect(attributes['gen_ai.main_agent.id']).toBe(
        'urn:agent:projects-123456789:projects:123456789:locations:us-central1:aiplatform:reasoningEngines:1234567890',
      );
    });
  });

  describe('agent URN off Agent Engine', () => {
    it.each([
      {
        name: 'a regional GKE cluster',
        attributes: GKE_ATTRIBUTES,
        expected:
          'urn:agent:projects-987654321:projects:987654321:locations:us-central1:container:clusters:my-cluster:k8s:namespaces:default:apps:deployments:my-agent',
      },
      {
        name: 'a zonal GKE cluster',
        attributes: {
          ...GKE_ATTRIBUTES,
          'cloud.region': '',
          'cloud.availability_zone': 'us-central1-c',
        },
        expected:
          'urn:agent:projects-987654321:projects:987654321:zones:us-central1-c:container:clusters:my-cluster:k8s:namespaces:default:apps:deployments:my-agent',
      },
      {
        name: 'a Cloud Run service',
        attributes: CLOUD_RUN_ATTRIBUTES,
        expected:
          'urn:agent:projects-987654321:projects:987654321:locations:us-central1:run:services:my-agent',
      },
    ])('names $name', async ({attributes, expected}) => {
      state.detectedAttributes = attributes;
      state.namespaceFile = 'default\n';
      vi.stubEnv('HOSTNAME', 'my-agent-5d8f7c9b4-x2k9p');

      const resolved = await settledAttributes(getGcpResource('urn-project'));

      expect(resolved['gen_ai.main_agent.id']).toBe(expected);
    });

    it('sets no URN on GKE when the namespace and Deployment are unknown', async () => {
      state.detectedAttributes = GKE_ATTRIBUTES;
      vi.stubEnv('HOSTNAME', 'not-a-pod');

      const resolved = await settledAttributes(getGcpResource('urn-project'));

      expect(resolved).not.toHaveProperty('gen_ai.main_agent.id');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('The GKE namespace is unknown'),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('The GKE Deployment is unknown'),
      );
    });

    it('sets no URN when the project number is unknown', async () => {
      state.detectedAttributes = {
        ...CLOUD_RUN_ATTRIBUTES,
        'cloud.account.id': 'unknown-project',
      };

      const resolved = await settledAttributes(
        getGcpResource('unknown-project'),
      );

      expect(resolved).not.toHaveProperty('gen_ai.main_agent.id');
      expect(warn).toHaveBeenCalledWith(
        "The number of project 'unknown-project' is unknown, so no agent URN is set.",
      );
    });

    it('sets no URN when no location is detected', async () => {
      state.detectedAttributes = {...CLOUD_RUN_ATTRIBUTES, 'cloud.region': ''};

      const resolved = await settledAttributes(getGcpResource('urn-project'));

      expect(resolved).not.toHaveProperty('gen_ai.main_agent.id');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Neither a zone nor a region'),
      );
    });

    it('sets no URN, and looks nothing up, on GCE', async () => {
      state.detectedAttributes = {
        'cloud.platform': 'gcp_compute_engine',
        'cloud.account.id': 'urn-project',
        'cloud.region': 'us-central1',
      };

      const resolved = await settledAttributes(getGcpResource('urn-project'));

      expect(resolved).not.toHaveProperty('gen_ai.main_agent.id');
      expect(state.lookups).toEqual([]);
    });

    it('keeps a URN the operator states', async () => {
      state.detectedAttributes = CLOUD_RUN_ATTRIBUTES;
      vi.stubEnv(
        'OTEL_RESOURCE_ATTRIBUTES',
        'gen_ai.main_agent.id=urn:agent:stated',
      );

      const resolved = await settledAttributes(getGcpResource('urn-project'));

      expect(resolved['gen_ai.main_agent.id']).toBe('urn:agent:stated');
    });
  });

  it('is the same resource buildGcpResource builds', async () => {
    const fromBuild = await settledAttributes(buildGcpResource('my-project'));
    const fromApi = await settledAttributes(getGcpResource('my-project'));

    expect(Object.keys(fromApi).sort()).toEqual(Object.keys(fromBuild).sort());
  });
});

describe('fetchProject', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAuth(answers: Record<string, string>) {
    const request = vi.fn(async (opts: {url: string}) => {
      const project = decodeURIComponent(opts.url.split('/').pop() ?? '');
      const number = answers[project];
      if (!number) {
        throw new Error('Permission denied.');
      }
      return {data: {projectId: project, name: `projects/${number}`}};
    });
    return {request};
  }

  it('returns both identifiers and memoizes a success', async () => {
    const auth = createAuth({'memo-project': '111'});

    const first = await fetchProject('memo-project', auth);
    const second = await fetchProject('memo-project', auth);

    expect(first).toEqual({id: 'memo-project', number: '111'});
    expect(second).toEqual(first);
    expect(auth.request).toHaveBeenCalledTimes(1);
    expect(auth.request).toHaveBeenCalledWith({
      url: 'https://cloudresourcemanager.googleapis.com/v3/projects/memo-project',
      method: 'GET',
    });
  });

  it('shares one lookup between concurrent callers', async () => {
    const auth = createAuth({'concurrent-project': '222'});

    const results = await Promise.all([
      fetchProject('concurrent-project', auth),
      fetchProject('concurrent-project', auth),
    ]);

    expect(results[0]).toEqual({id: 'concurrent-project', number: '222'});
    expect(results[1]).toEqual(results[0]);
    expect(auth.request).toHaveBeenCalledTimes(1);
  });

  it('does not memoize a failure', async () => {
    const auth = createAuth({});

    expect(await fetchProject('failing-project', auth)).toEqual({
      id: 'failing-project',
      number: '',
    });
    expect(await fetchProject('404404', auth)).toEqual({id: '', number: ''});
    await fetchProject('failing-project', auth);

    expect(auth.request).toHaveBeenCalledTimes(3);
  });

  it('rejects a project that is not a valid identifier without a lookup', async () => {
    const auth = createAuth({});

    expect(await fetchProject('evil.example/x?y#', auth)).toEqual({
      id: 'evil.example/x?y#',
      number: '',
    });
    expect(auth.request).not.toHaveBeenCalled();
  });

  it('keeps at most 32 projects, evicting the oldest', async () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i <= 32; i++) {
      answers[`cap-project-${i}`] = String(1000 + i);
    }
    const auth = createAuth(answers);

    for (let i = 0; i <= 32; i++) {
      await fetchProject(`cap-project-${i}`, auth);
    }
    await fetchProject('cap-project-32', auth);
    await fetchProject('cap-project-1', auth);
    expect(auth.request).toHaveBeenCalledTimes(33);

    await fetchProject('cap-project-0', auth);
    expect(auth.request).toHaveBeenCalledTimes(34);
  });
});
