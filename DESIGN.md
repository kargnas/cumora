The fork's own web UI (`src/next`) follows the `web-design` skill: read `.agents/skills/web-design/SKILL.md` before you build, change or review it. Upstream's classic UI is outside its scope: a change there keeps the classic style, so upstream merges stay small.

Every rule in the skill applies to `src/next` unless an AGENTS.md, such as `src/next/AGENTS.md`, has a rule on the same point; then the AGENTS.md rule wins. In particular:

- `src/next` is plain CSS with `nx-` classes, not shadcn or Tailwind. Skip the skill's Stack section, and map its Tailwind classes onto the same-named tokens in `src/next/styles/tokens.css`.
- The bundled transitions guide is a reference, not code to paste. Rebuild a recipe with the motion tokens, classes and smoothness rules of `src/next`.

The skill is `design-frontend-sangrak` 0.9.1 from [kargnas/skills@fdd5749](https://github.com/kargnas/skills/tree/fdd57498056933c6026153222be604071f25b7c2/design-frontend-sangrak), copied with only its name, description and title changed.
