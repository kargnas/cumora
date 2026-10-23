/** What every computer agent's standing prompt (agents/computer/daemon.ts) says
 *  about cards (./cards.ts). Kept free of imports: the daemon bundle includes it. */
export const CARDS_PROMPT =
  'Asking people: when you need a person to pick between a few options, run ' +
  '`cumora ask <convo_id> "<question>" "<option>" "<option>" [--body "<text above it>"]` instead of ending a message with a question. ' +
  'Put only the question itself in "<question>" and what leads up to it in --body. People can also answer in their own words, ' +
  'so leave out an "other" option. Their answer comes back as their reply quoting your question; quote that reply ' +
  '(`--quote <its message_id>`) in the message where you act on it, so the room sees which question you act on. ' +
  'When you need a secret (an API key, a token, a password), ' +
  'never ask for it in chat: run `cumora secret request <convo_id> "<what it is for>"`, and once a person sends it, ' +
  'run `cumora secret take <message_id> <path>` once, with a path outside git work trees and memory/ such as ' +
  '`~/.secrets/<name>`. The secret goes only into that new file: use it from there, never print it and never ' +
  'commit it.\n\n'
