const test = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const { generateAssistantResponse, SYSTEM_INSTRUCTION } = require('../src/services/assistantProvider');

test('Gemini requests enforce language matching, read-only behavior, and bounded output', async (t) => {
  const originalApiKey = config.geminiApiKey;
  config.geminiApiKey = 'test-gemini-key';
  t.after(() => {
    config.geminiApiKey = originalApiKey;
  });

  let receivedKey;
  let generationRequest;
  const query = 'माझ्या वॉलेटमध्ये किती पैसे आहेत?';
  const snapshot = { wallet: { balance: 1234 }, trades: [] };
  const response = await generateAssistantResponse(query, snapshot, (apiKey) => {
    receivedKey = apiKey;
    return {
      models: {
        async generateContent(request) {
          generationRequest = request;
          return { text: 'तुमच्या वॉलेटमध्ये १,२३४ USDT आहेत.' };
        },
      },
    };
  });

  assert.equal(receivedKey, 'test-gemini-key');
  assert.equal(response, 'तुमच्या वॉलेटमध्ये १,२३४ USDT आहेत.');
  assert.equal(generationRequest.model, 'gemini-flash-latest');
  assert.equal(generationRequest.config.maxOutputTokens, 256);
  assert.match(generationRequest.config.systemInstruction, /same language as the user query/);
  assert.match(generationRequest.config.systemInstruction, /read-only/);
  assert.match(generationRequest.config.systemInstruction, /Never place, cancel, or modify trades/);
  assert.deepEqual(JSON.parse(generationRequest.contents), {
    query,
    tradingSnapshot: snapshot,
  });
  assert.match(SYSTEM_INSTRUCTION, /Devanagari, Latin transliteration, and mixed-language speech/);
});

test('Gemini provider reports missing server configuration without exposing credentials', async () => {
  const originalApiKey = config.geminiApiKey;
  config.geminiApiKey = undefined;
  try {
    await assert.rejects(
      generateAssistantResponse('status', {}),
      (error) => error.code === 'AI_PROVIDER_NOT_CONFIGURED'
        && !error.message.includes('GEMINI_API_KEY')
        && !error.message.includes('test-gemini-key')
    );
  } finally {
    config.geminiApiKey = originalApiKey;
  }
});
