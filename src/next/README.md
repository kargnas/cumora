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

## Agents at work

An agent working in a room (it shows as typing there) peeks over the composer bar instead of taking a row in the transcript. Its head rises from behind the bar when it starts and ducks back when it stops, and the bar moves down by one fixed band while any head is up, however many agents work. Past six heads on a phone and nine elsewhere, the rest share one "+N" head. Hovering a head shows the agent's name and how long it has worked; clicking the heads (tapping them on a phone) lists everyone at work, opens an agent's profile from its row, and stops one agent with its stop button when its engine can stop a turn. A reply that streams in shows in the transcript as it is written.

## Message times

Each turn (one sender's unbroken run of messages) opens with the avatar and a name row carrying its time; your own messages carry theirs left of the bubble. Later messages in a turn show a time in the avatar column (right of the bubble in a 1:1 room, which has none) only after a gap, and a long silence inside a day gets a line saying how long it lasted (the thresholds are `STAMP_GAP_MIN` and `PAUSE_MS` in `chat/model.ts`). Every message keeps its time in place: hovering a message shows it, and clicking or tapping any time shows them all until the next click or until the room closes. The long-press sheet and the ⋯ menu start with the full date and the time to the second with the UTC offset.

Times carry no date. A chip marks where each day starts, and while the rows under the room header belong to a day whose chip is scrolled away, a pill under the header shows that day's date, so a room opened partway into an older day still says which day its times belong to. The pill takes the chip's place as the chip passes under the header and steps aside when the next day's chip comes up to it.

## Handbook

The room panel's first tab, and the Handbook view of an agent's profile, show one agent's standing files as one document: its `CLAUDE.md` or `AGENTS.md`, its memory (`memory/**/*.md`, `MEMORY.md` first), its own skills (`.claude/skills/*/SKILL.md`) and the skills every agent on the computer shares. A skill the selected range did not change shows only its name; opening it shows the whole file. In a room with several agents, the chips at the top pick one (`?agent=`).

The tab opens on the changes, not on the document, whose instructions alone outrun a phone screen:

- **The map** draws the whole document as short bars, one column per section and one bar per line (a long section merges neighbouring lines, keeping a change's colour), with each changed line in its colour: green added, red removed, the primary colour rewritten.
- **Excerpts** list the range's newest 20 changes, newest first: the file, the line where the change starts, its first six lines and the note. Older ones are marked only in the full text.
- **Full text** is folded. Pressing a spot on the map, an excerpt's head or "Show all N lines" opens it at that place under the toolbar.

- **Changes since** Today (midnight in your time zone), 7 days, 30 days or All time (`?since=`): removed words are struck through in red, added ones tinted green, and each change has a number. The note under a change names the person whose message most likely caused it and quotes the message, which opens in its room. A message from a room you are not in shows who wrote it and when, nothing more.
- **The scrubber** has a stop for every change and shows the document as it was right after it (`?at=`). Its far end is now, which keeps up with new changes.
- **Who can see it:** workspace owners and admins only, because an agent's files can quote any room. Text is redacted for tokens, keys and passwords.

The computer keeps no history of these files, so the server records one. `server/src/fork/recorder.ts` polls the files compose mounts read-only under `server/computer/` and stores every version in the fork's SQLite. The first version of a file in a home seen for the first time is a baseline, not a change, and a deletion is stored as a version too. A change belongs to the agent's run that was open at the file's mtime. Its instruction is the newest message a person wrote before that run started, in a room the agent posted in during the run (in its 1:1 rooms when it posted nowhere) and after its previous run started. The tab reads `GET /api/fork/agents/:agentId/handbook?since=&at=` (`server/src/fork/handbook.ts`) and polls it while it is open (`panel/handbook.ts`). While the scrubber or the range changes, the previous document stays on screen, dimmed, until the new one arrives, so dragging the scrubber never blanks the tab.

## Details tab

The room panel's Details tab has two cards. **This room** holds the room's own settings: the name (group rooms), the topic, pin and mute. Below it, workspace owners and admins get the room's agent: its name, role, bio and style save when the field loses focus, and "Model, computer and avatar" opens the full agent editor (`?agent-edit=<id>`, the same editor as the Agents section). An agent's settings follow it into every room it is in, which the card says. In a room with several agents, the chips pick one (`?agent=`, shared with the Handbook).

## Routines tab

The room panel's Routines tab lists the Calendar agent tasks that post into the room, one row per job with one switch. Calendar repeats at most daily, so an agent that wants a job every few hours books one daily event per time; events with the same agent, prompt and repeat rule whose titles share a stem fold into one job (`panel/routines.ts`), shown as "Every 3 hours · next 06:07". A job opens in place (`?routine=<event id>`) with its prompt, Run now, a switch per time, and **Repeats**, which turns a daily job into every 1, 2, 3, 4, 6, 8, 12 or 24 hours from its earliest time: times already booked stay with their run history, missing ones are created (starting at their next occurrence, so none fires on creation) and the rest are deleted. A time, like an event link in a message, opens the event in the panel (`?peek=event:<id>`) with the Calendar section's own detail; its Edit goes to Calendar.

Under the jobs come the room's **triggers**: routines that fire when a pull request merges in a GitHub repository instead of at a time (`panel/triggers.tsx`, `server/src/fork/triggers.ts`). A trigger names the repository, the gh profile on the computer that reads it (compose mounts the computer's `~/.config/gh` read-only under `server/computer/gh`), the agent and the prompt. The server polls each repository once a minute with a conditional request and posts, for every pull request merged after the trigger was made, the same system message as a Calendar firing (`calendar_event` with `eventKind: 'trigger'`, through upstream's own `postDispatchMessage`), so the agent wakes as it does for a routine and the transcript shows nothing. A merge fires once (`trigger_fires` in the fork's SQLite). A trigger opens in place (`?trigger=<id>`) with Run now, which fires the repository's latest merge again, its last fire and any polling error, and Delete. **New trigger** at the bottom of the tab creates one for the room.

A Calendar firing is a system row that wakes the agent. The transcript does not show it, and it is not unread, not the chat-list preview and not a reason to move the room up the list (the list query in `server/src/api/router.ts` leaves it out, and the live patch in `stores/conversations.ts` matches). A jump to one, from an event's run history, lands on the next thing in the room.

## Haptics

In the phone app, switching sections answers with a click when the finger lands. Opening a room from the chat list and toggling a reaction answer when the tap ends instead: they sit in lists that scroll, where a finger that lands may be starting a scroll, so a scroll plays nothing. A long press answers with a deeper click, sending a message with one click, and someone else's message arriving in the open room with a double click (not in muted rooms, at most once every 2 seconds). A save the user waited on ends with a success or error haptic. Android plays the system's own effects, so the phone's touch-feedback setting turns them off. The web and the desktop app have none.

## Animated avatars

An agent can wear a live [bloub](https://github.com/jeremy-prt/bloub) instead of its portrait. Owners and admins choose it in the agent editor (Edit on the profile, or "Model, computer and avatar" in the Details tab), whose Avatar section switches between Portrait and Animated. It previews the draft where people meet it, at those sizes: a message, a member chip, a mention, and beside up to four other agents. The first Animated look is random, in a color no other agent wears while one is left; colors other agents wear are dimmed, and a color or look another agent already has is named. "Play a moment" plays idle, thinking, working, a posted message, and a happy or a sad reply on the preview. The editor's Save keeps the avatar with the rest of the profile; Paint with AI saves a new portrait at once.

People pick only the shape and the color. The face follows the agent's messages: for every message an agent that wears a bloub posts, `server/src/fork/mood.ts` asks TypeSafe Jev (OpenRouter's decisions API, `OPENROUTER_API_KEY`) which of 16 faces fits it, stores the face with the look, and sends `fork.agent.mood` to the workspace. The face stays until the agent's next message; without the key, faces stay at rest. The look belongs to the agent for the whole workspace and is stored in the fork's SQLite database (`GET/PUT/DELETE /api/fork/bloub-avatars/:participantId`), so the classic UI, push notifications and email keep showing the portrait. The redesign loads the looks on start and whenever the app comes back to the foreground.

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
| Posts a message | `wink`, then back to its state, wearing the face Jev picks for the message |

A status that flips back within a moment does not flash a state: the first change shows at once, and each state then stays at least 1.2 s, the latest status winning. BYOA agents report `working` from the first engine hop that calls tools to the end of the turn and keep their status alive through the whole turn (`server/src/agents/computer/daemon.ts`); with it they send the kind of tool (`server/src/fork/toolKind.ts`), which the server passes to the clients as `fork.agent.tool` straight over Redis, so a client that missed it shows the generic work until the next one. Codex reports one hop per turn, so its agents stay on `thinking`. With reduced motion, each state is drawn once and settled, without the turn effects.

## Local verification

The redesign can run against a throwaway local backend:

1. Postgres + Redis in the `default` Colima profile (never the `circlechat` one), migrate with `npx tsx server/src/migrate-bin.ts`, start `npx tsx server/src/index.ts` with `DATABASE_URL`, `REDIS_URL`, a dummy `OPENAI_API_KEY` and `CUMORA_PUBLIC_ORIGIN` set to the origin the device opens (the Vite server, which proxies `/uploads`). Upload URLs carry that origin, so the default `http://localhost:5181` breaks uploaded images and portraits on any other device. The server seeds demo agents and rooms on first boot. `server/data/fork.sqlite` is created on the first `/api/fork` request, which opening the redesign's chat list sends, or at boot when `server/computer/` exists (step 4).
2. Mint a session with `createSession` from `server/src/auth.ts` and open `/next#token=<token>&companyId=personal`.
3. Live states (typing, streaming, working) can be driven from the browser console in dev: `(await import('/src/stores/messages.ts')).useMessages.setState(...)`.
4. For the Handbook, put sample files under `server/computer/agents/<agent id>/` and `server/computer/skills/<name>/SKILL.md` (gitignored) before starting the server; editing one afterwards records a change. A row in `agent_runs` around the file's mtime and a person's message before it show the attribution.
5. To try the Android app against it: `adb reverse tcp:<port> tcp:<port>`, set `"server": {"url": "http://localhost:<port>"}` in the generated `android/app/src/main/assets/capacitor.config.json` (the debug build allows cleartext only to localhost), build with `./gradlew assembleDebug`, and rebuild the production APK afterwards.
