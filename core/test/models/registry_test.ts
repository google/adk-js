import {BaseLlm, BaseLlmConnection, LlmAgent, LLMRegistry, LlmRequest, LlmResponse} from '@google/adk';
import {Blob, Content, createModelContent, GenerateContentResponse} from '@google/genai';

class TestLlmConnection implements BaseLlmConnection {
  async sendHistory(history: Content[]): Promise<void> {
    return Promise.resolve();
  }

  async sendContent(content: Content): Promise<void> {}

  async sendRealtime(blob: Blob): Promise<void> {}

  async * receive(): AsyncGenerator<LlmResponse, void, void> {}

  async close(): Promise<void> {}
}

class TestLlmModel extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }

  static override readonly supportedModels = ['test-llm-model'];

  async *
      generateContentAsync(llmRequest: LlmRequest, stream?: boolean):
          AsyncGenerator<LlmResponse, void> {
    const generateContentResponse = new GenerateContentResponse();

    generateContentResponse.candidates =
        [{content: createModelContent('test-llm-model-response')}];
    const candidate = generateContentResponse.candidates[0];

    yield {
      content: candidate.content,
      groundingMetadata: candidate.groundingMetadata,
      usageMetadata: generateContentResponse.usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new TestLlmConnection();
  }
}

describe('LLMRegistry', () => {
  beforeAll(() => {
    LLMRegistry.register(TestLlmModel);
  });

  it('resolves model to LLM class', () => {
    expect(LLMRegistry.newLlm('test-llm-model')).toBeInstanceOf(TestLlmModel);
  });

  it('resolves the provided as a string model correctly in LlmAgent', () => {
    const agent = new LlmAgent({name: 'test_agent', model: 'test-llm-model'});

    expect(agent.canonicalModel).toBeInstanceOf(TestLlmModel);
  });

  it('resolves the provided as class model correctly in LlmAgent', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new TestLlmModel({model: 'test-llm-model'})
    });

    expect(agent.canonicalModel).toBeInstanceOf(TestLlmModel);
  })
});
