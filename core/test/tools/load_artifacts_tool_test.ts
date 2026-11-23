/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  LOAD_ARTIFACTS,
  LlmRequest,
  LoadArtifactsTool,
} from '@google/adk';
import {Blob, Part, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {asSafePartForLlm} from '../../src/tools/load_artifacts_tool.js';

class StubToolContext {
  private artifactsByName: Record<string, Part>;

  constructor(artifactsByName: Record<string, Part>) {
    this.artifactsByName = artifactsByName;
  }

  // Minimal stub properties needed to bypass initialized checks
  invocationContext = {
    artifactService: {},
  };

  async listArtifacts(): Promise<string[]> {
    return Object.keys(this.artifactsByName);
  }

  async loadArtifact(name: string): Promise<Part | undefined> {
    return this.artifactsByName[name];
  }
}

describe('LoadArtifactsTool', () => {
  it('computes the correct declaration', () => {
    const tool = new LoadArtifactsTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('load_artifacts');
    expect(declaration?.description).toContain(
      'Loads artifacts into the session',
    );
    expect(declaration?.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        artifact_names: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
          },
          description: 'The names of the artifacts to load.',
        },
      },
    });
  });

  it('sets correct response on runAsync', async () => {
    const tool = new LoadArtifactsTool();
    const mockContext = {} as unknown as Context;

    const result = await tool.runAsync({
      args: {artifact_names: ['test1']},
      toolContext: mockContext,
    });

    expect(result).toEqual({
      artifact_names: ['test1'],
      status:
        'artifact contents temporarily inserted and removed. to access these artifacts, call load_artifacts tool again.',
    });
  });

  it('has a global instance LOAD_ARTIFACTS', () => {
    expect(LOAD_ARTIFACTS).toBeInstanceOf(LoadArtifactsTool);
  });

  it('converts unsupported text-like inline mime to text parts', async () => {
    const artifactName = 'test.csv';
    const csvString = 'col1,col2\n1,2\n';
    const csvBytesBase64 = Buffer.from(csvString, 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: csvBytesBase64, mimeType: 'application/csv'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    expect(addedContent.parts![0].text).toEqual(`Artifact ${artifactName} is:`);

    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeUndefined();
    expect(artifactPart.text).toEqual(csvString);
  });

  it('keeps supported inline mime types (pdf)', async () => {
    const artifactName = 'test.pdf';
    const pdfBytesBase64 = Buffer.from('%PDF-1.4', 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: pdfBytesBase64, mimeType: 'application/pdf'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeDefined();
    expect(artifactPart.inlineData?.mimeType).toEqual('application/pdf');
  });

  it('keeps supported inline mime types (image)', async () => {
    const artifactName = 'test.png';
    const imgBytesBase64 = Buffer.from('FAKEIMAGE', 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: imgBytesBase64, mimeType: 'image/png'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeDefined();
    expect(artifactPart.inlineData?.mimeType).toEqual('image/png');
  });

  it('converts unseen binary mime to size string placeholder text', async () => {
    const artifactName = 'test.bin';
    // 5 bytes
    const binBytesBase64 = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
    const artifact: Part = {
      inlineData: {data: binBytesBase64, mimeType: 'application/octet-stream'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeUndefined();
    // 5 bytes is 0.0048 KB, toFixed(1) -> 0.0 KB
    expect(artifactPart.text).toContain('size: 0.0 KB');
    expect(artifactPart.text).toContain(
      '[Binary artifact: test.bin, type: application/octet-stream',
    );
  });

  it('does not append artifacts if role is not user', async () => {
    const artifactName = 'test.csv';
    const csvString = 'col1,col2\n1,2\n';
    const csvBytesBase64 = Buffer.from(csvString, 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: csvBytesBase64, mimeType: 'application/csv'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'model', // Not 'tool'
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    // Content should remain length 1, no artifact appended
    expect(llmRequest.contents.length).toEqual(1);
  });

  it('handles missing artifactService gracefully', async () => {
    const toolContext = new StubToolContext({}) as unknown as Context;
    (
      toolContext.invocationContext as {artifactService: unknown}
    ).artifactService = undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Should return early and not throw
    expect(llmRequest.contents.length).toEqual(0);
  });

  it('handles missing or empty artifacts array', async () => {
    const toolContext = new StubToolContext({}) as unknown as Context;
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Should return early and not throw
    expect(llmRequest.contents.length).toEqual(0);
  });

  it('skips missing artifacts and tries user: prefix', async () => {
    const artifactName = 'test.txt';
    const artifact: Part = {text: 'hello'};

    // Register it as 'user:test.txt'
    const toolContext = new StubToolContext({
      [`user:${artifactName}`]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName, 'missing.txt']},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    // It should load user:test.txt, but skip missing.txt
    expect(llmRequest.contents.length).toEqual(2); // The functionResponse + the single loaded artifact part
    expect(llmRequest.contents[1].parts![1]).toEqual(artifact);
  });

  it('handles parts with no inlineData', async () => {
    const artifactName = 'test.txt';
    const artifact: Part = {text: 'I have no inlineData'};

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.length).toEqual(2);
    expect(llmRequest.contents[1].parts![1]).toEqual(artifact);
  });

  it('handles parts with inlineData but no data', async () => {
    const artifactName = 'test.txt';
    const artifact: Part = {
      inlineData: {mimeType: 'text/plain'} as unknown as Blob, // missing data field
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.length).toEqual(2);
    expect(llmRequest.contents[1].parts![1].text).toContain(
      'No inline data was provided',
    );
  });

  it('handles parts with inlineData but no mimeType', async () => {
    const artifactName = 'test.dat';
    const artifact: Part = {
      inlineData: {data: 'YmFzZTY0'} as unknown as Blob, // missing mimeType field
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.length).toEqual(2);
    expect(llmRequest.contents[1].parts![1].text).toContain(
      '[Binary artifact: test.dat, type: application/octet-stream',
    );
  });

  it('loads artifacts when called in parallel alongside other tools (issue #632)', async () => {
    const artifactName = 'test.txt';
    const textContent = 'Hello World';
    const artifact: Part = {
      text: textContent,
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Run tasks'}],
        },
        {
          role: 'model',
          parts: [
            {functionCall: {name: 'other_tool', args: {}}},
            {
              functionCall: {
                name: 'load_artifacts',
                args: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'other_tool',
                response: {status: 'ok'},
              },
            },
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent).toBeDefined();
    expect(addedContent?.parts?.[1]?.text).toEqual(textContent);
  });

  it('loads artifacts when called sequentially before other tools in the same turn (issue #632)', async () => {
    const artifactName = 'data.txt';
    const textContent = 'Sequential Data';
    const artifact: Part = {
      text: textContent,
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Run tasks'}],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'load_artifacts',
                args: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [{functionCall: {name: 'next_tool', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'next_tool',
                response: {status: 'done'},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent).toBeDefined();
    expect(addedContent?.parts?.[1]?.text).toEqual(textContent);
  });

  it('does not reload artifacts from previous turns if not called in current turn', async () => {
    const artifactName = 'old.txt';
    const artifact: Part = {
      text: 'Old Content',
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        // Turn 1
        {
          role: 'user',
          parts: [{text: 'Load old artifact'}],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'load_artifacts',
                args: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [{text: 'Old artifact was processed.'}],
        },
        // Turn 2
        {
          role: 'user',
          parts: [{text: 'New question without loading artifact'}],
        },
        {
          role: 'model',
          parts: [{functionCall: {name: 'other_tool', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'other_tool',
                response: {status: 'ok'},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent).toBeUndefined();
  });

  it('normalizes uppercase and mixed-case MIME types when loading artifacts', async () => {
    const textArtifactName = 'doc.txt';
    const textBase64 = Buffer.from('Normalized text', 'utf8').toString(
      'base64',
    );
    const imageArtifactName = 'pic.png';
    const imageBase64 = Buffer.from('IMGDATA', 'utf8').toString('base64');

    const toolContext = new StubToolContext({
      [textArtifactName]: {
        inlineData: {
          data: textBase64,
          mimeType: 'Text/Plain; charset=utf-8',
        },
      },
      [imageArtifactName]: {
        inlineData: {
          data: imageBase64,
          mimeType: 'IMAGE/PNG',
        },
      },
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {
                  artifact_names: [textArtifactName, imageArtifactName],
                },
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const textContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${textArtifactName} is:`),
    );
    expect(textContent?.parts?.[1]?.text).toEqual('Normalized text');

    const imageContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${imageArtifactName} is:`),
    );
    expect(imageContent?.parts?.[1]?.inlineData?.mimeType).toEqual('IMAGE/PNG');
  });

  it('decodes 0-byte text-like artifacts to empty text in request contents', async () => {
    const artifactName = 'empty.txt';
    const toolContext = new StubToolContext({
      [artifactName]: {
        inlineData: {data: '', mimeType: 'text/plain'},
      },
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent?.parts?.[1]?.text).toEqual('');
  });
});

describe('asSafePartForLlm', () => {
  it('normalizes uppercase and mixed-case MIME types with parameters', () => {
    const textPart = asSafePartForLlm(
      {
        inlineData: {
          mimeType: 'Text/Plain; charset=utf-8',
          data: Buffer.from('hello', 'utf8').toString('base64'),
        },
      },
      'doc.txt',
    );
    expect(textPart).toEqual({text: 'hello'});

    const jsonPart = asSafePartForLlm(
      {
        inlineData: {
          mimeType: 'APPLICATION/JSON',
          data: Buffer.from('{"count":1}', 'utf8').toString('base64'),
        },
      },
      'data.json',
    );
    expect(jsonPart).toEqual({text: '{"count":1}'});

    const imgPart = asSafePartForLlm(
      {
        inlineData: {
          mimeType: 'IMAGE/PNG',
          data: 'abc',
        },
      },
      'chart.png',
    );
    expect(imgPart).toEqual({
      inlineData: {
        mimeType: 'IMAGE/PNG',
        data: 'abc',
      },
    });

    const pdfPart = asSafePartForLlm(
      {
        inlineData: {
          mimeType: 'Application/PDF; charset=utf-8',
          data: 'pdfbytes',
        },
      },
      'doc.pdf',
    );
    expect(pdfPart).toEqual({
      inlineData: {
        mimeType: 'Application/PDF; charset=utf-8',
        data: 'pdfbytes',
      },
    });
  });

  it('decodes 0-byte text-like inline artifacts to empty text', () => {
    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'text/plain', data: ''}},
        'empty.txt',
      ),
    ).toEqual({text: ''});

    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'application/json', data: ''}},
        'empty.json',
      ),
    ).toEqual({text: ''});

    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'application/csv', data: ''}},
        'empty.csv',
      ),
    ).toEqual({text: ''});

    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'application/xml', data: ''}},
        'empty.xml',
      ),
    ).toEqual({text: ''});
  });

  it('returns missing data placeholder for empty binary data or undefined data', () => {
    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'application/octet-stream', data: ''}},
        'empty.bin',
      ),
    ).toEqual({
      text: '[Artifact: empty.bin, type: application/octet-stream. No inline data was provided.]',
    });

    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'text/plain'} as unknown as Blob},
        'missing.txt',
      ),
    ).toEqual({
      text: '[Artifact: missing.txt, type: text/plain. No inline data was provided.]',
    });
  });

  it('formats supported inline media as placeholders when inlineMediaAsPlaceholder is true', () => {
    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'image/png', data: 'abc'}},
        'chart.png',
        {inlineMediaAsPlaceholder: true},
      ),
    ).toEqual({
      text: '[Binary artifact: chart.png, type: image/png, size: 0.0 KB. Content cannot be displayed inline.]',
    });

    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'application/pdf', data: 'abc'}},
        'doc.pdf',
        {inlineMediaAsPlaceholder: true},
      ),
    ).toEqual({
      text: '[Binary artifact: doc.pdf, type: application/pdf, size: 0.0 KB. Content cannot be displayed inline.]',
    });

    expect(
      asSafePartForLlm(
        {inlineData: {mimeType: 'image/png', data: ''}},
        'empty.png',
        {inlineMediaAsPlaceholder: true},
      ),
    ).toEqual({
      text: '[Artifact: empty.png, type: image/png. No inline data was provided.]',
    });
  });

  it('formats fileData artifacts as placeholders when inlineMediaAsPlaceholder is true', () => {
    expect(
      asSafePartForLlm(
        {
          fileData: {
            fileUri: 'gs://bucket/contract.pdf',
            mimeType: 'Application/PDF',
          },
        },
        'contract.pdf',
        {inlineMediaAsPlaceholder: true},
      ),
    ).toEqual({
      text: '[Artifact: contract.pdf, uri: gs://bucket/contract.pdf, type: application/pdf.]',
    });

    expect(
      asSafePartForLlm(
        {
          fileData: {
            fileUri: '',
            mimeType: '',
          },
        },
        'unknown_file',
        {inlineMediaAsPlaceholder: true},
      ),
    ).toEqual({
      text: '[Artifact: unknown_file, uri: unknown, type: application/octet-stream.]',
    });
  });

  it('preserves media and fileData artifacts when inlineMediaAsPlaceholder is not set', () => {
    const imagePart: Part = {inlineData: {mimeType: 'image/png', data: 'abc'}};
    expect(asSafePartForLlm(imagePart, 'chart.png')).toBe(imagePart);

    const filePart: Part = {
      fileData: {
        fileUri: 'gs://bucket/file.pdf',
        mimeType: 'application/pdf',
      },
    };
    expect(asSafePartForLlm(filePart, 'doc.pdf')).toBe(filePart);
  });
});
