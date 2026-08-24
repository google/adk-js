/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/artifacts.
 *
 * Ported as literally as the two APIs allow: same tool names, same parameter
 * names, same instruction text, same artifact filenames, MIME types and
 * message strings. Divergence in the transcript should come from the runtimes,
 * not from the agent definition.
 *
 * The one deliberate difference: the Python sample builds its MP4 with
 * OpenCV, a third-party Python library with no counterpart here, so the
 * `video` branch reports that instead of writing a file. The image and audio
 * branches are byte-for-byte equivalents of the Python generators.
 */
import {FunctionTool, LlmAgent, LoadArtifactsTool} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

/** Generates a simple valid WAV file (a 440Hz sine wave). */
function generateWav(): Buffer {
  const sampleRate = 44100;
  const duration = 1.0; // seconds
  const frequency = 440.0; // sine wave frequency (A4)
  const numSamples = Math.trunc(sampleRate * duration);

  const samples = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const value = Math.trunc(
      32767.0 * Math.sin((2.0 * Math.PI * frequency * i) / sampleRate),
    );
    samples.writeInt16LE(value, i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length, 40);

  return Buffer.concat([header, samples]);
}

/** Generates a simple valid BMP file (a red square). */
function generateBmp(): Buffer {
  const width = 100;
  const height = 100;
  const fileSize = 54 + 3 * width * height;

  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(0, 6);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(0, 34);
  header.writeInt32LE(0, 38);
  header.writeInt32LE(0, 42);
  header.writeUInt32LE(0, 46);
  header.writeUInt32LE(0, 50);

  const pixelData = Buffer.alloc(3 * width * height);
  for (let i = 0; i < width * height; i++) {
    // Red pixels in BGR
    pixelData[i * 3] = 0x00;
    pixelData[i * 3 + 1] = 0x00;
    pixelData[i * 3 + 2] = 0xff;
  }

  return Buffer.concat([header, pixelData]);
}

const generateReport = new FunctionTool({
  name: 'generate_report',
  description: 'Generates a report on a topic and saves it as an artifact.',
  parameters: z.object({
    topic: z.string().describe('The topic of the report.'),
    format: z
      .string()
      .describe("The format of the report ('text' or 'html').")
      .default('text'),
  }),
  execute: async ({topic, format}, ctx) => {
    let mimeType: string;
    let filename: string;
    let content: string;

    if (format.toLowerCase() === 'html') {
      mimeType = 'text/html';
      filename = 'report.html';
      content = `<html>
<head><title>Report on ${topic}</title></head>
<body>
<h1>REPORT: ${topic}</h1>
<hr>
<p>This is a detailed report about ${topic}.</p>
<p>It contains a lot of useful information that would clutter the conversation history.</p>
<ul>
<li>Key point 1</li>
<li>Key point 2</li>
<li>Key point 3</li>
</ul>
</body>
</html>`;
    } else {
      mimeType = 'text/plain';
      filename = 'report.txt';
      content = `REPORT: ${topic}
=========================================
This is a detailed report about ${topic}.
It contains a lot of useful information that would clutter the conversation history.
- Key point 1
- Key point 2
- Key point 3
`;
    }

    const version = await ctx!.saveArtifact(filename, {
      inlineData: {
        data: Buffer.from(content, 'utf8').toString('base64'),
        mimeType,
      },
    });
    return {
      message:
        `Report on ${topic} saved as artifact '${filename}' (version` +
        ` ${version}).`,
      filename,
      version,
    };
  },
});

const generateMediaArtifact = new FunctionTool({
  name: 'generate_media_artifact',
  description: 'Generates a valid media artifact of specified type.',
  parameters: z.object({
    media_type: z.string().describe("One of 'image', 'audio', 'video'."),
  }),
  execute: async ({media_type: mediaType}, ctx) => {
    let mimeType: string;
    let filename: string;
    let data: Buffer;

    if (mediaType === 'image') {
      mimeType = 'image/bmp';
      data = generateBmp();
      filename = 'sample_image.bmp';
    } else if (mediaType === 'audio') {
      mimeType = 'audio/wav';
      data = generateWav();
      filename = 'sample_audio.wav';
    } else if (mediaType === 'video') {
      // The Python sample encodes an MP4 with OpenCV. There is no equivalent
      // dependency here, so the branch reports the gap rather than pretending
      // to have produced a file.
      return {
        error:
          'Video generation is not available in the TypeScript port: the' +
          ' Python sample uses opencv-python, which has no counterpart here.',
      };
    } else {
      return {error: `Unsupported media type: ${mediaType}`};
    }

    const version = await ctx!.saveArtifact(filename, {
      inlineData: {data: data.toString('base64'), mimeType},
    });

    return {
      message:
        `Media artifact '${filename}' generated and saved (version` +
        ` ${version}).`,
      filename,
      version,
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'artifacts_agent',
  model: PARITY_MODEL,
  tools: [generateReport, generateMediaArtifact, new LoadArtifactsTool()],
  instruction: `You are an agent that can manage artifacts, including different media types.

    - To generate a text report, use \`generate_report\`.
    - To generate image, audio, or video artifacts, use \`generate_media_artifact\`.

    When the user asks about an artifact or to load it, use \`load_artifacts\`.
    `,
});
