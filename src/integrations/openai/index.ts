import { app, safeStorage, shell } from 'electron';
import { config } from '../../config.js';
import { createChatGptAuth, type ChatGptAuth } from './chatgpt.js';
import { createResponsesProvider } from './responses.js';

// Main-process instances: the person's ChatGPT sign-in and the two OpenAI-backed providers.

let auth: ChatGptAuth | undefined;

/** Sign in with ChatGPT for this installation. Created on first use, once Electron's app is ready. */
export function chatgptAuth(): ChatGptAuth {
  auth ??= createChatGptAuth({
    dir: app.getPath('userData'),
    openBrowser: (url) => shell.openExternal(url),
    // The keychain seals token fields at rest; without it the file is still owner-only.
    sealer: safeStorage.isEncryptionAvailable()
      ? { seal: (t) => safeStorage.encryptString(t).toString('base64'), unseal: (t) => safeStorage.decryptString(Buffer.from(t, 'base64')) }
      : undefined,
    agentName: config.chatgpt.agentName,
    enabled: config.chatgpt.enabled,
  });
  return auth;
}

/** The person's ChatGPT plan: Vowe's preferred provider. */
export const chatgptPlan = createResponsesProvider({
  id: 'chatgpt',
  name: 'ChatGPT',
  billing: 'chatgpt-plan',
  model: config.agent.chatgptModel,
  isConfigured: () => {
    const status = chatgptAuth().status();
    return status.enabled && status.signedIn && status.planUsage === 'granted';
  },
  bearer: async () => (await chatgptAuth().accessToken()).token,
});

/** An OpenAI API key from .env: a fallback, billed to that key. */
export const openaiApiKey = createResponsesProvider({
  id: 'openai',
  name: 'OpenAI API',
  billing: 'api-key',
  model: config.agent.openaiModel,
  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),
  bearer: async () => process.env.OPENAI_API_KEY ?? '',
});
