/**
 * Text the fork sends that an agent or a person wrote must never carry a
 * credential, and redaction must not eat prose that only looks like one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preview, redact } from '../fork/redact.js'

test('redact removes credentials of every listed shape', () => {
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abc.def.ghi123" x', 'abc.def.ghi123'],
    ['Authorization=Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['sent Bearer 9f8e7d6c5b4a39281706 upstream', '9f8e7d6c5b4a39281706'],
    ['header Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', 'eyJzdWIiOiIxMjM0In0'],
    ['key sk-proj-AbCdEfGhIjKlMnOpQrSt', 'AbCdEfGhIjKlMnOpQrSt'],
    ['ghp_0123456789abcdefghijABCDEFGHIJ012345 pushed', '0123456789abcdefghij'],
    ['gho_0123456789abcdefghijABCD', '0123456789abcdefghij'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '11ABCDEFG0123456789'],
    ['slack xoxb-1234567890-abcdefghij', '1234567890-abcdefghij'],
    ['aws AKIAIOSFODNN7EXAMPLE done', 'AKIAIOSFODNN7EXAMPLE'],
    ['git clone https://alice:s3cretpw@github.com/x/y', 's3cretpw'],
    ['GITHUB_TOKEN=abc123 npm publish', 'abc123'],
    ['https://api.example.com/v1?api_key=zzz999&page=2', 'zzz999'],
    ['DB_PASSWORD="hunter 2" ./run', 'hunter 2'],
    ['deploy --token abc123def', 'abc123def'],
    ['deploy --api-key=xyz789', 'xyz789'],
    ['{"access_token": "tok-value-1"}', 'tok-value-1'],
    ['password: hunter2', 'hunter2'],
  ]
  for (const [input, secret] of cases) {
    const out = redact(input)
    assert.ok(!out.includes(secret), `${JSON.stringify(input)} still shows ${secret}: ${out}`)
    assert.ok(out.includes('[redacted]'), `${JSON.stringify(input)} was not marked: ${out}`)
  }
  assert.equal(redact('git clone https://alice:s3cretpw@github.com/x/y'), 'git clone https://[redacted]@github.com/x/y')
  assert.equal(redact('deploy --token abc123def now'), 'deploy --token [redacted] now')
})

test('redact keeps prose that only resembles a credential', () => {
  for (const text of [
    'Authorization header missing',
    'Basic Information about the launch',
    'task-1234567890abcdefgh finished',
    'risk-assessment-for-the-quarter',
    'cumora board move card-abc Done',
  ]) {
    assert.equal(redact(text), text)
  }
})

test('preview redacts before it cuts and keeps one line', () => {
  const key = `sk-${'a'.repeat(40)}`
  const out = preview(`${'x'.repeat(30)} ${key}`, 40)
  assert.ok(out && !out.includes('aaaa'), `a cut must not expose part of a key: ${out}`)
  assert.equal(preview('Fix the digest\n\n  and post it at 9', 100), 'Fix the digest and post it at 9')
  assert.equal(preview('  \n  ', 100), null)
  assert.equal(preview(null, 100), null)
  assert.equal(preview('abcdefghij', 5), 'abcd…')
})
