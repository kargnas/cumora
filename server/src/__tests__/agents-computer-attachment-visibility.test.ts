/**
 * A BYOA agent must be able to tell that a message carried a file.
 *
 * A user sent a 626KB zip and asked "这个能看到么". The agent answered, truthfully,
 * that it saw only the text — the attachment was in `messages.attachment`, was
 * selected by `loadInbox`, and reached the daemon, and then `snapshotUnread`
 * built each digest line from `row.body` alone. `daemon.ts` contained no
 * reference to `attachment` at all. The cloud path (turn.ts) always surfaced
 * them; only the BYOA path dropped them.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-attachment-visibility.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'
process.env.CUMORA_PUBLIC_ORIGIN = 'https://chat.example.com'

const { attachmentNote } = await import('../agents/computer/daemon.js')
const { agentAttachmentUrl } = await import('../storage.js')

test('a local-storage upload reaches the agent as a URL it can fetch', async () => {
  // Local storage serves uploads at `/uploads/<key>`, a path only the web app's
  // own origin resolves. The note keeps http(s) URLs only, so the agent saw
  // "image.png" and nothing it could open, and asked the user to retype the
  // table that was in the screenshot.
  const att = await agentAttachmentUrl({
    url: '/uploads/attachments/01e6.png',
    key: 'attachments/01e6.png',
    kind: 'img',
    mime: 'image/png',
    name: 'image.png',
    size: 205_859,
  })
  assert.equal(att.url, 'https://chat.example.com/uploads/attachments/01e6.png')
  assert.match(attachmentNote(att), /https:\/\/chat\.example\.com\/uploads\/attachments\/01e6\.png\]$/)
})

test('the reported zip is now visible to the agent', () => {
  const note = attachmentNote({
    name: 'talking-head-visual-director-v1.0.zip',
    kind: 'file',
    mime: 'application/zip',
    size: 626 * 1024,
    url: 'https://cdn.cumora.ai/a/abc?sig=1',
  })
  assert.match(note, /talking-head-visual-director-v1\.0\.zip/)
  assert.match(note, /application\/zip/)
  assert.match(note, /626KB/)
  // The agent has to be able to actually fetch it, not just know it exists.
  assert.match(note, /https:\/\/cdn\.cumora\.ai\/a\/abc\?sig=1/)
})

test('a message with no attachment gains nothing', () => {
  assert.equal(attachmentNote(null), '')
  assert.equal(attachmentNote(undefined), '')
  assert.equal(attachmentNote({}), '  [attachment: file]')
})

test('megabyte sizes read as megabytes', () => {
  assert.match(attachmentNote({ name: 'a.mov', size: 5 * 1024 * 1024 }), /5\.0MB/)
  // Never report a real file as "0KB".
  assert.match(attachmentNote({ name: 'tiny.txt', size: 12 }), /1KB/)
})

test('hostile fields cannot run away with the digest line', () => {
  const note = attachmentNote({
    name: 'x'.repeat(5000),
    mime: 'y'.repeat(5000),
    size: Number.NaN,
    // Not http(s): must not be offered to the agent as something to fetch.
    url: 'file:///etc/passwd',
  })
  assert.ok(note.length < 260, `digest line must stay bounded, got ${note.length}`)
  assert.equal(note.includes('file:///etc/passwd'), false, 'only http(s) urls are surfaced')
  assert.equal(note.includes('NaN'), false)
})
