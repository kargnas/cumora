# Next redesign mode (`/next`)

A second UI for cumora, served at `/next` on the same origin. `App.tsx` mounts `NextApp` in place of the classic Desktop/Mobile shells, so auth, stores, the WebSocket stream and mark-read logic are shared. Rules for changing it are in `AGENTS.md` next to this file.

## Switching

- The web opens it when `localStorage['cumora.ui']` is `next`: visiting `/next` once sets it, and `/` then redirects there.
- The native apps (Capacitor, Electron) open it unless `localStorage['cumora.ui']` is `classic`.
- "Switch to classic design" in the workspace menu sets `classic`.

## Chat list

- Pinned rooms sit at the top as tiles that wrap onto new rows. Pin from a room's menu, or drag a room onto the tiles: while a room is dragged, a Pin slot (or a "Drop here to pin" zone when the last line is full) shows where. Drag a tile onto another to reorder the tiles, or back into the list to unpin it; on a phone, a tile's long-press menu has Move left and Move right. A pin is shared with the room's other members; the tile order is yours.
- Below them, rooms are grouped into your own categories, then Other. Other gets its header only once a category exists. A 1:1 room whose other member has left (a deleted agent or a removed member) is not listed. Create a category from the + menu, drag a room onto a category (or onto "Drop here for a new category"), and click a category header to collapse it. Drag a header to reorder the categories; every group folds while it moves. Right-click a header (long-press on a phone) for Rename, Move up, Move down, Mark all as read, Hide and Delete; Other's menu has Mark all as read. A hidden category leaves the list: the "N hidden" row at the bottom carries its unread count and opens it, and its menu has Show. On a phone, a room's long-press menu has "Move to".
- Categories, their order, hidden categories, collapsed groups and the tile order are personal and stored in the fork's SQLite database on the server, so they follow you across devices.

## Handbook

The room panel's first tab, and the Handbook view of an agent's profile, show one agent's standing files as one document: its `CLAUDE.md` or `AGENTS.md`, its memory (`memory/**/*.md`, `MEMORY.md` first), its own skills (`.claude/skills/*/SKILL.md`) and the skills every agent on the computer shares. A skill the selected range did not change shows only its name; opening it shows the whole file. In a room with several agents, the chips at the top pick one (`?agent=`).

- **Changes since** Today (midnight in your time zone), 7 days, 30 days or All time (`?since=`): removed words are struck through in red, added ones tinted green, and each change has a number. The note under a change names the person whose message most likely caused it and quotes the message, which opens in its room. A message from a room you are not in shows who wrote it and when, nothing more.
- **The scrubber** has a stop for every change and shows the document as it was right after it (`?at=`). Its far end is now, which keeps up with new changes.
- **Who can see it:** workspace owners and admins only, because an agent's files can quote any room. Text is redacted for tokens, keys and passwords.

The computer keeps no history of these files, so the server records one. `server/src/fork/recorder.ts` polls the files compose mounts read-only under `server/computer/` and stores every version in the fork's SQLite. The first version of a file in a home seen for the first time is a baseline, not a change, and a deletion is stored as a version too. A change belongs to the agent's run that was open at the file's mtime. Its instruction is the newest message a person wrote before that run started, in a room the agent posted in during the run (in its 1:1 rooms when it posted nowhere) and after its previous run started. The tab reads `GET /api/fork/agents/:agentId/handbook?since=&at=` (`server/src/fork/handbook.ts`) and polls it while it is open (`panel/handbook.ts`). While the scrubber or the range changes, the previous document stays on screen, dimmed, until the new one arrives, so dragging the scrubber never blanks the tab.

## Details tab

The room panel's Details tab has two cards. **This room** holds the room's own settings: the name (group rooms), the topic, pin and mute. Below it, workspace owners and admins get the room's agent: its name, role, bio and style save when the field loses focus, and "Model, computer and avatar" opens the full agent editor (`?agent-edit=<id>`, the same editor as the Agents section). An agent's settings follow it into every room it is in, which the card says. In a room with several agents, the chips pick one (`?agent=`, shared with the Handbook).

## Haptics

In the phone app, opening a room from the chat list, switching sections and toggling a reaction answer with a click when the finger lands. A long press answers with a deeper click, sending a message with one click, and someone else's message arriving in the open room with a double click (not in muted rooms, at most once every 2 seconds). A save the user waited on ends with a success or error haptic. Android plays the system's own effects, so the phone's touch-feedback setting turns them off. The web and the desktop app have none.

## Animated avatars

An agent can wear a live [bloub](https://github.com/jeremy-prt/bloub) instead of its portrait. Owners and admins turn it on in the agent's profile (Animated avatar) and pick a shape, a color and a resting face; the profile's large avatar plays each pick at once. The look belongs to the agent for the whole workspace and is stored in the fork's SQLite database (`GET/PUT/DELETE /api/fork/bloub-avatars/:participantId`), so the classic UI, push notifications and email keep showing the portrait. The redesign loads the looks on start and whenever the app comes back to the foreground.

Every avatar of the agent plays what it is doing (`bloub/program.ts`):

| Agent | bloub |
| --- | --- |
| Available | `idle`: gaze drift and blinking |
| Thinking | `thinking`: three pulsing dots |
| Working with a tool it can name | Leans back and acts it out with a prop it looks at: a page read line by line (Read, `cumora glance`), a pen writing on the page (Write, Edit, `cumora reply`), a terminal (Bash), a magnifier (Grep, Glob), a globe (WebFetch, WebSearch) |
| Working with another tool | `play` and `orbit` in turn |
| Waiting | `notify`: the blue dot |
| Offline (its computer is off, resting or off-boarded) | `sleep`: a small bouncing dot |
| Starts a turn | `burst` before the busy state |
| Ends a turn | `comet` before `idle` |
| Posts a message | `wink`, then back to its state |

A status that flips back within a moment does not flash a state: modes change at most every 1.2 s. BYOA agents report `working` after an engine hop that called tools and keep their status alive through the whole turn (`server/src/agents/computer/daemon.ts`); with it they send the kind of tool (`server/src/fork/toolKind.ts`), which the server passes to the clients as `fork.agent.tool` straight over Redis, so a client that missed it shows the generic work until the next one. Codex reports one hop per turn, so its agents stay on `thinking`. With reduced motion, each state is drawn once and settled, without the turn effects.

## Local verification

The redesign can run against a throwaway local backend:

1. Postgres + Redis in the `default` Colima profile (never the `circlechat` one), migrate with `npx tsx server/src/migrate-bin.ts`, start `npx tsx server/src/index.ts` with `DATABASE_URL`, `REDIS_URL`, a dummy `OPENAI_API_KEY` and `CUMORA_PUBLIC_ORIGIN` set to the origin the device opens (the Vite server, which proxies `/uploads`). Upload URLs carry that origin, so the default `http://localhost:5181` breaks uploaded images and portraits on any other device. The server seeds demo agents and rooms on first boot. `server/data/fork.sqlite` is created on the first `/api/fork` request, which opening the redesign's chat list sends, or at boot when `server/computer/` exists (step 4).
2. Mint a session with `createSession` from `server/src/auth.ts` and open `/next#token=<token>&companyId=personal`.
3. Live states (typing, streaming, working) can be driven from the browser console in dev: `(await import('/src/stores/messages.ts')).useMessages.setState(...)`.
4. For the Handbook, put sample files under `server/computer/agents/<agent id>/` and `server/computer/skills/<name>/SKILL.md` (gitignored) before starting the server; editing one afterwards records a change. A row in `agent_runs` around the file's mtime and a person's message before it show the attribution.
5. To try the Android app against it: `adb reverse tcp:<port> tcp:<port>`, set `"server": {"url": "http://localhost:<port>"}` in the generated `android/app/src/main/assets/capacitor.config.json` (the debug build allows cleartext only to localhost), build with `./gradlew assembleDebug`, and rebuild the production APK afterwards.
