/**
 * Local storage served every upload to anyone who had its URL, forever: the
 * random file name was the only lock, and agents now pass those URLs around.
 * Local mode signs them like the R2 gate does, and `/uploads` refuses the rest.
 *
 * Run: node --import tsx --test server/src/__tests__/local-upload-signing.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENAI_API_KEY ??= 'test-key'
process.env.CUMORA_PUBLIC_ORIGIN = 'https://chat.example.com'

const { storage, localUploadRefusal, storageKeyFromPublicUrl, signedUrlExpiresSoon } =
  await import('../storage.js')

/** What the `/uploads` handler sees for a URL publicUrl minted. */
function refusalFor(url: string): string | null {
  const parsed = new URL(url, 'http://local.test')
  return localUploadRefusal(
    parsed.pathname.slice('/uploads'.length),
    parsed.searchParams.get('exp') ?? undefined,
    parsed.searchParams.get('sig') ?? undefined,
  )
}

test('an attachment URL is signed and only its own signature opens it', async () => {
  const url = await storage.publicUrl('attachments/01e6.png')
  assert.match(url, /^\/uploads\/attachments\/01e6\.png\?exp=\d+&sig=[0-9a-f]{64}$/)
  assert.equal(refusalFor(url), null)

  const { searchParams } = new URL(url, 'http://local.test')
  const exp = searchParams.get('exp')!
  const sig = searchParams.get('sig')!
  assert.equal(localUploadRefusal('/attachments/01e6.png', undefined, undefined), 'missing exp/sig')
  assert.equal(localUploadRefusal('/attachments/other.png', exp, sig), 'bad sig')
  assert.equal(localUploadRefusal('/attachments/01e6.png', String(Number(exp) + 1), sig), 'bad sig')
  assert.equal(localUploadRefusal('/attachments/01e6.png', '1000', sig), 'expired')
  const tooFar = String(Math.floor(Date.now() / 1000) + 2 * 86_400)
  assert.equal(localUploadRefusal('/attachments/01e6.png', tooFar, sig), 'exp too far')
})

test('portraits stay public and paths outside storage stay shut', async () => {
  assert.equal(await storage.publicUrl('avatars/a.png'), '/uploads/avatars/a.png')
  assert.equal(localUploadRefusal('/avatars/a.png', undefined, undefined), null)
  assert.equal(localUploadRefusal('/attachments/../avatars/a.png', undefined, undefined), 'not a storage key')
  assert.equal(localUploadRefusal('/secret.txt', undefined, undefined), 'not a storage key')
})

test('an agent-posted public URL still resolves to its storage key', () => {
  // Agents read absolute URLs (agentAttachmentUrl) and may post one back into
  // a message or document; recognising it lets that copy be re-signed instead
  // of dying when its signature expires.
  assert.equal(
    storageKeyFromPublicUrl('https://chat.example.com/uploads/attachments/01e6.png?exp=1&sig=ab'),
    'attachments/01e6.png',
  )
  assert.equal(storageKeyFromPublicUrl('https://elsewhere.example/uploads/attachments/01e6.png'), null)
})

test('expiry is read from relative local URLs too', () => {
  assert.equal(signedUrlExpiresSoon('/uploads/attachments/01e6.png?exp=1000&sig=ab'), true)
  const later = Math.floor(Date.now() / 1000) + 3600
  assert.equal(signedUrlExpiresSoon(`/uploads/attachments/01e6.png?exp=${later}&sig=ab`), false)
})
