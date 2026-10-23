/** How long an answer typed into a question card may be. The server refuses a
 *  longer one (MAX_ANSWER in server/src/fork/cards.ts), and fork-cards.test.ts
 *  keeps the two equal, which is why this module imports nothing. */
export const MAX_ANSWER = 4000
