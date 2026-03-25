import {FunctionTool} from '@google/adk';
import * as fs from 'node:fs/promises';
import {z} from 'zod';
import {FILE_STORAGE} from '../storage/file_storage.js';

export const CREATE_FILE_TOOL = new FunctionTool({
  name: 'create_file',
  description: 'Create a file',
  parameters: z.object({
    filePath: z.string().describe('File name'),
    content: z.string().describe('Content'),
  }),
  execute: async ({filePath, content}) => {
    if (!filePath || !content) {
      throw new Error('File creation failed: Missing filePath or Content');
    }

    await fs.writeFile(filePath, content, {encoding: 'utf-8'});

    const fileId = crypto.randomUUID();
    FILE_STORAGE.set(fileId, filePath);

    return {
      status: 'success',
      fileId,
    };
  },
});

export const UPDATE_FILE_TOOL = new FunctionTool({
  name: 'update_file',
  description: 'Update a file',
  parameters: z.object({
    fileId: z.string().describe('File id'),
    content: z.string().describe('Content'),
  }),
  execute: async ({fileId, content}) => {
    if (!fileId || !content) {
      throw new Error('File update failed: Missing fileId or Content');
    }

    const fileUri = await FILE_STORAGE.get(fileId);
    if (!fileUri) {
      throw new Error(`File ${fileId} not found`);
    }

    await fs.writeFile(fileUri, content, {encoding: 'utf-8'});

    return {
      status: 'success',
      fileId,
    };
  },
});

export const READ_FILE_TOOL = new FunctionTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: z.object({
    fileId: z.string().describe('File id'),
  }),
  execute: async ({fileId}) => {
    if (!fileId) {
      throw new Error('File read failed: Missing fileId');
    }

    const fileUri = await FILE_STORAGE.get(fileId);
    if (!fileUri) {
      throw new Error(`File ${fileId} not found`);
    }

    const content = await fs.readFile(fileUri, {encoding: 'utf-8'});

    return {
      status: 'success',
      fileId,
      content,
    };
  },
});

export const DELETE_FILE_TOOL = new FunctionTool({
  name: 'delete_file',
  description: 'Delete a file',
  parameters: z.object({
    fileId: z.string().describe('File id'),
  }),
  execute: async ({fileId}) => {
    if (!fileId) {
      throw new Error('File delete failed: Missing fileId');
    }

    const fileUri = await FILE_STORAGE.get(fileId);
    if (!fileUri) {
      throw new Error(`File ${fileId} not found`);
    }

    await fs.unlink(fileUri);
    FILE_STORAGE.delete(fileId);

    return {
      status: 'success',
      fileId,
    };
  },
});

export const FILE_SYSTEM_TOOLS = [
  CREATE_FILE_TOOL,
  UPDATE_FILE_TOOL,
  READ_FILE_TOOL,
  DELETE_FILE_TOOL,
];
