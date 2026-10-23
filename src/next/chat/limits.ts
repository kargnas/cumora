/** How long an answer typed into a question card may be. The server refuses a
 *  longer one (MAX_ANSWER in server/src/fork/cards.ts). fork-cards.test.ts
 *  imports this module in node to keep the two equal, so it imports nothing. */
export const MAX_ANSWER = 4000
