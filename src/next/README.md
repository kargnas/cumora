# Next redesign mode (`/next`)

A second UI for cumora, served at `/next` on the same origin. `App.tsx` mounts `NextApp` in place of the classic Desktop/Mobile shells, so auth, stores, the WebSocket stream and mark-read logic are shared. Rules for changing it are in `AGENTS.md` next to this file.

## Switching

- The web opens it when `localStorage['cumora.ui']` is `next`: visiting `/next` once sets it, and `/` then redirects there.
- The native apps (Capacitor, Electron) open it unless `localStorage['cumora.ui']` is `classic`.
- "Switch to classic design" in the workspace menu sets `classic`.

## Chat list

- Pinned rooms sit at the top as tiles that wrap onto new rows. Pin from a room's menu, or drag a room onto the tiles; drag a tile back into the list to unpin it.
- Below them, rooms are grouped into your own categories, then Other, then Former (1:1 rooms whose other member has left: a deleted agent or a removed member). Other gets its header only once a category exists. Create a category from the + menu, drag a room onto a category (or onto "Drop here for a new category"), and click a category header to collapse it. On a phone, a room's long-press menu has "Move to".
- Categories and collapsed groups are personal and stored in the fork's SQLite database on the server, so they follow you across devices.

## Haptics

In the phone app, a touch that changes something (switching a tab, picking from a menu, a long press, sending, dropping a card, a save that finished or failed) answers with a haptic. Android plays the system's own effects, so the phone's touch-feedback setting turns them off. The web and the desktop app have none.

## Local verification

The redesign can run against a throwaway local backend:

1. Postgres + Redis in the `default` Colima profile (never the `circlechat` one), migrate with `npx tsx server/src/migrate-bin.ts`, start `npx tsx server/src/index.ts` with `DATABASE_URL`, `REDIS_URL` and a dummy `OPENAI_API_KEY`. The server seeds demo agents and rooms on first boot. `server/data/fork.sqlite` is created on the first `/api/fork` request, which opening the redesign's chat list sends.
2. Mint a session with `createSession` from `server/src/auth.ts` and open `/next#token=<token>&companyId=personal`.
3. Live states (typing, streaming, working) can be driven from the browser console in dev: `(await import('/src/stores/messages.ts')).useMessages.setState(...)`.
4. To try the Android app against it: `adb reverse tcp:<port> tcp:<port>`, set `"server": {"url": "http://localhost:<port>"}` in the generated `android/app/src/main/assets/capacitor.config.json` (the debug build allows cleartext only to localhost), build with `./gradlew assembleDebug`, and rebuild the production APK afterwards.
