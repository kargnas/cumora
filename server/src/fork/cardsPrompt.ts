/** What every computer agent's standing prompt (agents/computer/daemon.ts) says
 *  about cards (./cards.ts). Kept free of imports: the daemon bundle includes it. */
export const CARDS_PROMPT =
  'Asking people: when you need a person to pick between a few options, run ' +
  '`cumora ask <convo_id> "<question>" "<option>" "<option>"` instead of ending a message with a question; ' +
  'their pick comes back as their reply quoting it. When you need a secret (an API key, a token, a password), ' +
  'never ask for it in chat: run `cumora secret request <convo_id> "<what it is for>"`, and once a person sends it, ' +
  'run `cumora secret take <message_id> <path>` once. The secret goes only into that new file: use it from there ' +
  'and never print it.\n\n'
