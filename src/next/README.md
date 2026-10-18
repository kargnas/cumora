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

## Activity tab

The room panel's Activity tab shows what the agents in the room are doing now (live cards) and what their recent runs did that the chat does not show. Each run card has the agent, when it ran, how long it took and what it cost (`~` marks an estimated price), then:

- **Changed**: cards created, moved, edited or deleted, card comments, boards, docs created or edited, calendar events, and posts in other rooms you are in. Each one opens the card, board, doc, event or message.
- **Went wrong**: a failed or stalled run with its error, the run's error events, failed steps, and routines that should have posted into the room and could not.
- **Show all steps**: the tool calls, only for engines that report them (cloud agents; BYOA engines report none). The command text of a step shows to workspace owners and admins only, because it can quote any room.

The data comes from `GET /api/fork/rooms/:conversationId/activity` (`server/src/fork/activity.ts`, which also holds the run and history limits), for members of the room only. Card moves, card edits and deletions reach back only as long as the realtime outbox keeps its rows (`COMPLETED_RETENTION_HOURS` in `server/src/realtime-outbox.ts`), because it is the only place that records who made them. The tab loads when it opens and polls (`panel/activity.ts`) while an agent in the room is live or a run is still open. Text in the response is redacted for tokens, keys and passwords, and capped.

## Haptics

In the phone app, opening a room from the chat list, switching sections and toggling a reaction answer with a click when the finger lands. A long press answers with a deeper click, sending a message with one click, and someone else's message arriving in the open room with a double click (not in muted rooms, at most once every 2 seconds). A save the user waited on ends with a success or error haptic. Android plays the system's own effects, so the phone's touch-feedback setting turns them off. The web and the desktop app have none.

## Local verification

The redesign can run against a throwaway local backend:

1. Postgres + Redis in the `default` Colima profile (never the `circlechat` one), migrate with `npx tsx server/src/migrate-bin.ts`, start `npx tsx server/src/index.ts` with `DATABASE_URL`, `REDIS_URL`, a dummy `OPENAI_API_KEY` and `CUMORA_PUBLIC_ORIGIN` set to the origin the device opens (the Vite server, which proxies `/uploads`). Upload URLs carry that origin, so the default `http://localhost:5181` breaks uploaded images and portraits on any other device. The server seeds demo agents and rooms on first boot. `server/data/fork.sqlite` is created on the first `/api/fork` request, which opening the redesign's chat list sends.
2. Mint a session with `createSession` from `server/src/auth.ts` and open `/next#token=<token>&companyId=personal`.
3. Live states (typing, streaming, working) can be driven from the browser console in dev: `(await import('/src/stores/messages.ts')).useMessages.setState(...)`.
4. To try the Android app against it: `adb reverse tcp:<port> tcp:<port>`, set `"server": {"url": "http://localhost:<port>"}` in the generated `android/app/src/main/assets/capacitor.config.json` (the debug build allows cleartext only to localhost), build with `./gradlew assembleDebug`, and rebuild the production APK afterwards.
