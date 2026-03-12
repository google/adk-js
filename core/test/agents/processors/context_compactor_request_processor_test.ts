import {describe, expect, it, vi} from 'vitest';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {ContextCompactorRequestProcessor} from '../../../src/agents/processors/context_compactor_request_processor.js';
import {BaseContextCompactor} from '../../../src/context/base_context_compactor.js';
import {LlmRequest} from '../../../src/models/llm_request.js';

describe('ContextCompactorRequestProcessor', () => {
  it('should run compactors in order and stop after first compaction', async () => {
    const mockCtx = {} as InvocationContext;
    const mockReq = {} as LlmRequest;

    const compactor1: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(false),
      compact: vi.fn(),
    };

    const compactor2: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const compactor3: BaseContextCompactor = {
      shouldCompact: vi.fn().mockReturnValue(true),
      compact: vi.fn(),
    };

    const processor = new ContextCompactorRequestProcessor([
      compactor1,
      compactor2,
      compactor3,
    ]);

    const generator = processor.runAsync(mockCtx, mockReq);
    for await (const _ of generator) {
      // iterate
    }

    expect(compactor1.shouldCompact).toHaveBeenCalledWith(mockCtx);
    expect(compactor1.compact).not.toHaveBeenCalled();

    expect(compactor2.shouldCompact).toHaveBeenCalledWith(mockCtx);
    expect(compactor2.compact).toHaveBeenCalledWith(mockCtx);

    expect(compactor3.shouldCompact).not.toHaveBeenCalled();
    expect(compactor3.compact).not.toHaveBeenCalled();
  });
});
