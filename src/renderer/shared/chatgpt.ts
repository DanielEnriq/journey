import type { ChatGptStatus } from '../../shared/api.js';
import { Store } from './store.js';

// Sign in with ChatGPT, as the renderer sees it: status only. The main process holds the tokens
// (integrations/openai/chatgpt.ts). Separate from Google sign-in, which is who you are in rooms.

/** `undefined` until main answers; `null` when it couldn't. */
export const chatgpt = new Store<{ status: ChatGptStatus | null | undefined; busy: boolean; error: string | null }>({
  status: undefined,
  busy: false,
  error: null,
});

window.journey.chatgpt.onChange((status) => chatgpt.setState({ status }));
window.journey.chatgpt.status().then(
  (status) => { if (chatgpt.state.status === undefined) chatgpt.setState({ status }); },
  () => { if (chatgpt.state.status === undefined) chatgpt.setState({ status: null }); },
);

async function run(action: () => Promise<unknown>) {
  chatgpt.setState({ busy: true, error: null });
  try {
    await action();
  } catch (err) {
    chatgpt.setState({ error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(err) });
  } finally {
    chatgpt.setState({ busy: false });
  }
}

export const continueWithChatGpt = (account?: string) => run(() => window.journey!.chatgpt.signIn(account));
export const signOutOfChatGpt = () => run(() => window.journey!.chatgpt.signOut());
export const dismissChatGptWelcome = () => run(() => window.journey!.chatgpt.dismissWelcome());
