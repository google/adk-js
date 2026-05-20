import {Gemini} from './core/src/models/google_llm.js';
import {LlmRequest} from './core/src/models/llm_request.js';
import {LlmResponse} from './core/src/models/llm_response.js';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) {
    console.error(
      'ERROR: GEMINI_API_KEY or GOOGLE_GENAI_API_KEY is not set in environment.',
    );
    console.log(
      'Please run this script with: GEMINI_API_KEY=your_key npx tsx verify_interactions.ts',
    );
    process.exit(1);
  }

  console.log('Initializing Gemini model with useInteractionsApi: true...');
  const model = new Gemini({
    model: 'gemini-2.5-flash',
    apiKey: apiKey,
    useInteractionsApi: true,
  });

  // Turn 1
  const req1: LlmRequest = {
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [{text: 'My favorite color is deep blue. Remember this.'}],
      },
    ],
  };

  console.log('\n--- Turn 1 Request ---');
  console.log(JSON.stringify(req1, null, 2));

  console.log('Sending Turn 1...');
  const res1List: LlmResponse[] = [];
  for await (const chunk of model.generateContentAsync(req1)) {
    res1List.push(chunk);
    process.stdout.write(chunk.content?.parts?.[0]?.text || '');
  }
  console.log('\n');

  const finalRes1 = res1List[res1List.length - 1];
  console.log('--- Turn 1 Final Response ---');
  console.log(JSON.stringify(finalRes1, null, 2));

  const interactionId = finalRes1.interactionId;
  if (!interactionId) {
    console.error('ERROR: No interactionId returned in Turn 1 response!');
    process.exit(1);
  }
  console.log(`SUCCESS: Got interactionId: ${interactionId}`);

  // Turn 2
  const req2: LlmRequest = {
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [{text: 'What is my favorite color?'}],
      },
    ],
    previousInteractionId: interactionId,
  };

  console.log('\n--- Turn 2 Request ---');
  console.log(JSON.stringify(req2, null, 2));

  console.log('Sending Turn 2 (should recall Turn 1)...');
  const res2List: LlmResponse[] = [];
  for await (const chunk of model.generateContentAsync(req2)) {
    res2List.push(chunk);
    process.stdout.write(chunk.content?.parts?.[0]?.text || '');
  }
  console.log('\n');

  const finalRes2 = res2List[res2List.length - 1];
  console.log('--- Turn 2 Final Response ---');
  console.log(JSON.stringify(finalRes2, null, 2));

  if (finalRes2.content?.parts?.[0]?.text?.toLowerCase().includes('blue')) {
    console.log(
      '\n🎉 SUCCESS: The model correctly recalled the favorite color from Turn 1 state!',
    );
  } else {
    console.log(
      '\n❌ FAILURE: The model did not seem to recall the favorite color.',
    );
  }
}

main().catch((err) => {
  console.error('Unhandled error during verification:', err);
});
