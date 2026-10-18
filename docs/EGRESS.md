# Server egress

The server does not have one shared HTTP client. Three call sites leave the
process, and they do not enforce the same checks. There is no `guard-*.mjs`
that fails CI when a fourth call site appears. This page is the contract each
one actually implements.

| Caller | Destination control | SSRF checks | Redirects | Bounds |
| --- | --- | --- | --- | --- |
| `server/src/agents/image-fetcher.ts` `fetchImageBytes` | Caller-supplied image URL | DNS lookup and `BlockList`: reject the answer set if any address is non-public, then connect to a validated address | Manual, each hop re-checked | 5s, 10 MB, 5 redirects, content-type allowlist; failures are cached and dropped |
| `server/src/agents/skills.ts` | Operator `SKILLHUB_URL` only. An agent cannot pass an install URL | None. No DNS or IP check | `redirect: 'error'` | 10s timeout; 100 files, 256 KB each |
| `server/src/oauth.ts` `mirrorAvatar` | The URL returned by Google, GitHub, or a configured GitLab | None | `fetch` default | 5s, 2 MB, allowlisted image types. Failure returns the original URL |

New outbound calls should follow `fetchImageBytes` unless the destination is
an operator-configured base URL, and even then a redirect must not be able to
leave that host.

`mirrorAvatar` is the odd one out: the provider URL is not chosen by an
end user today, and a failure must not block sign-in, but the fetch itself
has no private-network check.
