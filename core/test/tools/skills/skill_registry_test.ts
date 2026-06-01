/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {
  Context,
  GCPSkillRegistry,
  InvocationContext,
  LlmRequest,
  LoadSkillResourceTool,
  LoadSkillTool,
  RunSkillScriptTool,
  SearchSkillsTool,
  Skill,
  SkillToolset,
  loadSkillFromZipBuffer,
} from '@google/adk';
import AdmZip from 'adm-zip';
import {describe, expect, it, vi} from 'vitest';

describe('skill_registry', () => {
  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        invocationId: 'inv-123',
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
    });
  }

  const validSkillMd = `---
name: test-remote-skill
description: A test remote skill
---
Instruction body`;

  function createValidZipBuffer() {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from(validSkillMd, 'utf-8'));
    zip.addFile('references/ref1.md', Buffer.from('ref content', 'utf-8'));
    zip.addFile('assets/asset1.txt', Buffer.from('asset content', 'utf-8'));
    zip.addFile('scripts/run.sh', Buffer.from('echo hello', 'utf-8'));
    zip.addFile('__pycache__/cache.pyc', Buffer.from('dummy', 'utf-8'));
    zip.addFile('references/subdir/', Buffer.from(''));
    zip.addFile('references/', Buffer.from(''));
    return zip.toBuffer();
  }

  describe('loadSkillFromZipBuffer', () => {
    it('successfully loads a skill with all resources from zip buffer', () => {
      const zipBuffer = createValidZipBuffer();
      const skill = loadSkillFromZipBuffer(zipBuffer);

      expect(skill.frontmatter.name).toBe('test-remote-skill');
      expect(skill.instructions).toBe('Instruction body');
      expect(skill.resources?.references?.['ref1.md']).toBe('ref content');
      expect(skill.resources?.assets?.['asset1.txt']).toBe('asset content');
      expect(skill.resources?.scripts?.['run.sh']?.src).toBe('echo hello');
    });

    it('throws error if SKILL.md is missing', () => {
      const zip = new AdmZip();
      zip.addFile('dummy.txt', Buffer.from('hello'));
      expect(() => loadSkillFromZipBuffer(zip.toBuffer())).toThrow(
        'SKILL.md not found in zipped filesystem.',
      );
    });
  });

  describe('GCPSkillRegistry', () => {
    it('initializes with default options', () => {
      const envProj = process.env.GOOGLE_CLOUD_PROJECT;
      process.env.GOOGLE_CLOUD_PROJECT = 'mock-env-proj';
      const reg = new GCPSkillRegistry();
      expect(reg).toBeDefined();
      if (envProj === undefined) {
        delete process.env.GOOGLE_CLOUD_PROJECT;
      } else {
        process.env.GOOGLE_CLOUD_PROJECT = envProj;
      }
    });

    it('getSkill fetches and extracts a zipped skill', async () => {
      const zipBuffer = createValidZipBuffer();
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
              zippedFilesystem: zipBuffer.toString('base64'),
            }),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      const skill = await reg.getSkill('test-remote-skill');
      expect(skill.frontmatter.name).toBe('test-remote-skill');
    });

    it('getSkill handles zipped_filesystem snake_case format', async () => {
      const zipBuffer = createValidZipBuffer();
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
              zipped_filesystem: zipBuffer.toString('base64'),
            }),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      const skill = await reg.getSkill('test-remote-skill');
      expect(skill.frontmatter.name).toBe('test-remote-skill');
    });

    it('getSkill throws error if zippedFilesystem is missing', async () => {
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      await expect(reg.getSkill('missing-zip')).rejects.toThrow(
        "Skill 'missing-zip' does not contain zipped filesystem.",
      );
    });

    it('searchSkills retrieves and formats search results', async () => {
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
              retrievedSkills: [
                {
                  skillName: 'projects/proj/locations/loc/skills/found-skill',
                  description: 'A found skill',
                },
              ],
            }),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      const results = await reg.searchSkills('find skill');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('found-skill');
      expect(results[0].description).toBe('A found skill');
    });

    it('searchSkills handles snake_case retrieved_skills response', async () => {
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
              retrieved_skills: [
                {
                  skill_name: 'projects/proj/locations/loc/skills/found-skill',
                  description: 'A found skill',
                },
              ],
            }),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      const results = await reg.searchSkills('find skill');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('found-skill');
    });

    it('searchSkills returns empty array when retrievedSkills is empty', async () => {
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      const results = await reg.searchSkills('find skill');
      expect(results.length).toBe(0);
    });
    it('searchSkills handles empty skillName and description fallback', async () => {
      const mockClient = {
        apiClient: {
          request: vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
              retrievedSkills: [{}],
            }),
          }),
        },
      };

      const reg = new GCPSkillRegistry({
        client: mockClient as unknown as Client,
      });
      const results = await reg.searchSkills('find skill');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('');
      expect(results[0].description).toBe('');
    });
  });

  describe('SearchSkillsTool', () => {
    it('throws error if toolset has no registry', () => {
      const toolset = new SkillToolset([]);
      expect(() => new SearchSkillsTool(toolset)).toThrow(
        'SearchSkillsTool requires a configured skill registry.',
      );
    });

    it('returns declaration with search_skills', () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
        searchToolDescription: vi
          .fn()
          .mockReturnValue('Custom search description'),
      };

      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new SearchSkillsTool(toolset);
      const dec = tool._getDeclaration();
      expect(dec.name).toBe('search_skills');
      expect(dec.description).toBe('Custom search description');
    });

    it('runAsync validates missing query', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new SearchSkillsTool(toolset);
      const res = (await tool.runAsync({
        args: {},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('INVALID_ARGUMENTS');
    });

    it('runAsync searches registry and filters local skills', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn().mockResolvedValue([
          {name: 'remote-only', description: 'remote'},
          {name: 'already-local', description: 'local'},
        ]),
      };
      const localSkill: Skill = {
        frontmatter: {name: 'already-local', description: 'desc'},
        instructions: 'inst',
      };

      const toolset = new SkillToolset([localSkill], {registry: mockRegistry});
      const tool = new SearchSkillsTool(toolset);
      const res = (await tool.runAsync({
        args: {query: 'skills'},
        toolContext: createMockContext(),
      })) as Array<Record<string, unknown>>;

      expect(res.length).toBe(1);
      expect(res[0].name).toBe('remote-only');
    });

    it('runAsync returns error on registry exception', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn().mockRejectedValue(new Error('Registry failure')),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new SearchSkillsTool(toolset);
      const res = (await tool.runAsync({
        args: {query: 'skills'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('REGISTRY_ERROR');
    });

    it('runAsync returns error on string throw', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn().mockRejectedValue('String error failure'),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new SearchSkillsTool(toolset);
      const res = (await tool.runAsync({
        args: {query: 'skills'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('REGISTRY_ERROR');
      expect(res.error).toContain('String error failure');
    });
  });

  describe('SkillToolset upgraded capabilities', () => {
    it('getOrFetchSkill returns local skill', async () => {
      const localSkill: Skill = {
        frontmatter: {name: 'local-skill', description: 'desc'},
        instructions: 'inst',
      };
      const toolset = new SkillToolset([localSkill]);
      const res = await toolset.getOrFetchSkill('local-skill');
      expect(res).toBe(localSkill);
    });

    it('getOrFetchSkill returns undefined if no registry and skill not local', async () => {
      const toolset = new SkillToolset([]);
      const res = await toolset.getOrFetchSkill('remote-skill');
      expect(res).toBeUndefined();
    });

    it('getOrFetchSkill fetches from registry and caches per invocation', async () => {
      const remoteSkill: Skill = {
        frontmatter: {name: 'fetched-skill', description: 'desc'},
        instructions: 'inst',
      };
      const mockRegistry = {
        getSkill: vi.fn().mockResolvedValue(remoteSkill),
        searchSkills: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});

      const res1 = await toolset.getOrFetchSkill('fetched-skill', 'inv-1');
      expect(res1).toBe(remoteSkill);
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(1);

      // Second call with same invocation ID should hit cache
      const res2 = await toolset.getOrFetchSkill('fetched-skill', 'inv-1');
      expect(res2).toBe(remoteSkill);
      expect(mockRegistry.getSkill).toHaveBeenCalledTimes(1);

      await toolset.close();
    });

    it('getOrFetchSkill rethrows registry fetch errors', async () => {
      const mockRegistry = {
        getSkill: vi.fn().mockRejectedValue(new Error('Registry error')),
        searchSkills: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      await expect(
        toolset.getOrFetchSkill('bad-skill', 'inv-1'),
      ).rejects.toThrow('Registry error');
    });

    it('processLlmRequest appends search instruction if registry configured', async () => {
      const mockRegistry = {
        getSkill: vi.fn(),
        searchSkills: vi.fn(),
      };
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const req: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await toolset.processLlmRequest(createMockContext(), req);
      expect(req.config?.systemInstruction).toContain('search_skills');
    });
  });

  describe('Updated Tool implementations with Registry integration', () => {
    const remoteSkill: Skill = {
      frontmatter: {
        name: 'test-registry-skill',
        description: 'desc',
        metadata: {adk_additional_tools: []},
      },
      instructions: 'instructions',
      resources: {
        references: {'doc.md': 'doc text'},
        assets: {'img.png': Buffer.from('img data')},
        scripts: {'test.js': {src: 'console.log(1)'}},
      },
    };

    const mockRegistry = {
      getSkill: vi.fn().mockImplementation((name: string) => {
        if (name === 'test-registry-skill') return Promise.resolve(remoteSkill);
        if (name === 'error-skill')
          return Promise.reject(new Error('Fetch err'));
        return Promise.resolve(undefined);
      }),
      searchSkills: vi.fn(),
    };

    it('LoadSkillTool fetches remote skill on demand', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillTool(toolset);

      const res = (await tool.runAsync({
        args: {name: 'test-registry-skill'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;

      expect(res.skill_name).toBe('test-registry-skill');
      expect(res.instructions).toBe('instructions');
    });

    it('LoadSkillTool handles missing skill name', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillTool(toolset);
      const res = (await tool.runAsync({
        args: {},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('MISSING_SKILL_NAME');
    });

    it('LoadSkillTool handles registry fetch errors', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillTool(toolset);
      const res = (await tool.runAsync({
        args: {name: 'error-skill'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('REGISTRY_ERROR');
    });

    it('LoadSkillTool handles skill not found', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillTool(toolset);
      const res = (await tool.runAsync({
        args: {name: 'unknown-skill'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('SKILL_NOT_FOUND');
    });

    it('LoadSkillResourceTool fetches remote skill resource on demand', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillResourceTool(toolset);

      const res = (await tool.runAsync({
        args: {skill_name: 'test-registry-skill', path: 'references/doc.md'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;

      expect(res.content).toBe('doc text');
    });

    it('LoadSkillResourceTool validates missing parameters', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillResourceTool(toolset);
      let res = (await tool.runAsync({
        args: {path: 'foo'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('MISSING_SKILL_NAME');

      res = (await tool.runAsync({
        args: {skill_name: 'foo'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('MISSING_RESOURCE_PATH');
    });

    it('LoadSkillResourceTool handles registry fetch error', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillResourceTool(toolset);
      const res = (await tool.runAsync({
        args: {skill_name: 'error-skill', path: 'references/doc.md'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('REGISTRY_ERROR');
    });

    it('LoadSkillResourceTool handles skill not found', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillResourceTool(toolset);
      const res = (await tool.runAsync({
        args: {skill_name: 'unknown-skill', path: 'references/doc.md'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.error_code).toBe('SKILL_NOT_FOUND');
    });

    it('LoadSkillResourceTool processLlmRequest successfully resolves binary injection for remote skill', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillResourceTool(toolset);

      const req: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: {
                    status:
                      'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                    skill_name: 'test-registry-skill',
                    path: 'assets/img.png',
                  },
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest: req,
      });
      expect(req.contents!.length).toBe(2);
      expect(req.contents![1].parts![1].inlineData?.data).toBe(
        Buffer.from('img data').toString('base64'),
      );
    });

    it('LoadSkillResourceTool processLlmRequest continues gracefully on error fetching skill', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new LoadSkillResourceTool(toolset);

      const req: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: {
                    status:
                      'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                    skill_name: 'error-skill',
                    path: 'assets/img.png',
                  },
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest: req,
      });
      expect(req.contents!.length).toBe(1);
    });

    it('RunSkillScriptTool checks remote skill script on demand', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new RunSkillScriptTool(toolset);

      const res = (await tool.runAsync({
        args: {
          skill_name: 'test-registry-skill',
          script_path: 'scripts/test.js',
        },
        toolContext: createMockContext(),
      })) as Record<string, unknown>;

      expect(res.error).toBe('No code executor configured.');
    });

    it('RunSkillScriptTool validates missing parameters', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new RunSkillScriptTool(toolset);
      let res = (await tool.runAsync({
        args: {script_path: 'foo'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.errorCode).toBe('MISSING_SKILL_NAME');

      res = (await tool.runAsync({
        args: {skill_name: 'foo'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.errorCode).toBe('MISSING_SCRIPT_PATH');
    });

    it('RunSkillScriptTool handles registry fetch error', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new RunSkillScriptTool(toolset);
      const res = (await tool.runAsync({
        args: {skill_name: 'error-skill', script_path: 'scripts/test.js'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.errorCode).toBe('REGISTRY_ERROR');
    });

    it('RunSkillScriptTool handles skill not found', async () => {
      const toolset = new SkillToolset([], {registry: mockRegistry});
      const tool = new RunSkillScriptTool(toolset);
      const res = (await tool.runAsync({
        args: {skill_name: 'unknown-skill', script_path: 'scripts/test.js'},
        toolContext: createMockContext(),
      })) as Record<string, unknown>;
      expect(res.errorCode).toBe('SKILL_NOT_FOUND');
    });
  });
});
