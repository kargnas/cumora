This is opgginc/cumora, OP.GG's fork of [yetone/cumora](https://github.com/yetone/cumora). Instances run it as the `cumora` submodule of [opgginc/cumora-setup](https://github.com/opgginc/cumora-setup), whose AGENTS.md owns deploying.

- Every change reaches `main` through a pull request, merged only when the user says so. Ask for a review with a top-level `@opgg-ai-devops` comment naming the head commit. Ask again only after pushing fixes, and never while a review is running: a new request can cancel it.
- A merged change reaches an instance only after a PR on opgginc/cumora-setup moves its pointer to the commit the merge made.
- Bring upstream in with `git merge upstream/main` on a branch, never a rebase. Its review request names the files where conflicts were resolved, and its PR is merged with a merge commit, never squashed: the fork must keep upstream's commits as ancestors.
- Data that only the fork needs goes into the fork's SQLite store (`server/src/fork`, file `server/data/fork.sqlite`), never into a new upstream Postgres table or migration.
- Web UI follows `DESIGN.md`; read it before you build, change or review UI.
- The redesigned UI (`src/next`) has its own rules in `src/next/AGENTS.md`; read them before changing it. Its animations must stay perfectly smooth, with no dropped frames, on phones and the desktop app. Every layout and action must work on a phone, an unfolded foldable and a PC.
