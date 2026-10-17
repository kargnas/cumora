# Next redesign mode (`/next`)

A second UI for cumora, served at `/next` on the same origin. `App.tsx` mounts `NextApp` in place of the classic Desktop/Mobile shells, so auth, stores, the WebSocket stream and mark-read logic are shared. Visiting `/next` once sets `localStorage['cumora.ui'] = 'next'`, which redirects `/` there (the native app always opens `/`); "Switch to classic design" in the workspace menu clears it.

## Isolation

- Everything lives in `src/next/`. Classic files are only read, never restyled: `App.tsx` has the mount branch and the sign-in fallback, `components/Message.tsx` exports its artifact cards, `components/AuthScreen.tsx` exports `useSignIn` (the provider flows) and its parts, `stores/messages.ts` keeps `createdAt` on messages, and `electron/main.cjs` serves `index.html` for client-side routes.
- The native apps (Capacitor, Electron) open the redesign unless `localStorage['cumora.ui']` is `classic`; the web opens it only when it is `next`.
- CSS is plain, in `src/next/styles/` and next to components. Tokens are scoped to `html.nx` (set by `NextApp`), and every class starts with `nx-`, so nothing leaks into the classic UI.
- Classic components reused inside the redesign (thread drawer, peeks, editors, modals) pick up the new palette through the legacy token remap at the end of `styles/tokens.css`.
- Strings: `useNT()` from `i18n.ts`. Core keys are in `locales/en.ts` and `locales/zh-CN.ts`; each section keeps its keys in `sections/<name>/strings.ts` (prefixed `<name>.`), merged into the catalogue. English is the source of truth; other locales fall back to it.

## Design system

- Tokens (`styles/tokens.css`): `--background --card --popover --foreground --muted-foreground --primary --accent --muted --border --input --selected --live --warn --destructive`, light and dark (`html.dark`, driven by the existing appearance store).
- Type scale only: `--text-kpi` 24, `--text-title` 14, `--text-body` 13, `--text-caption` 12, `--text-micro` 11. Message text uses 14. The only exception is 16px for editable text on touch (iOS zooms anything smaller).
- Spacing steps 4/8/12/16; no padding above 16px. Same padding on all sides for boxes; asymmetric only on buttons and chips.
- One elevation: `var(--shadow-card)` (none in dark), floating layers `var(--shadow-float)`.
- Numbers, ids and times use `.nx-mono` (JetBrains Mono, tabular).
- Never: left accent borders, KPI/stat tiles, eyebrow labels, hero + 3-column feature grids, gradients as decoration, `transition: all`.
- Touch (`@media (pointer: coarse)`): 44px targets, menus become bottom sheets, actions revealed by hover must also be reachable by long-press.

## Motion and rendering

- Motion tokens: `--duration-quick/fast/medium/slow` and `--ease-smooth-out`; framer presets `T_QUICK`, `T_FAST`, `T_MEDIUM`, `SPRING_SHEET` in `ui/primitives.tsx`. Animate only `transform`, `opacity`, `clip-path`, `filter`.
- Long lists: `react-virtuoso`, rows memoized on the store object (the store replaces only changed objects). Never subscribe a list to a whole store when a row can select its own slice.
- Entrances play once per item per session (see `chat/MessageList.tsx`), never on remount.
- Loading: skeletons only for first load; spinners scoped to the region or control that is waiting (`aria-busy`).

## Building blocks

- `router.ts`: the URL is the state. `href({ section, id, panel, peek, params })`, `withRoute(route, patch)`, `navigate(to, { replace })`, `goBack(fallback)`, `linkClick` for `<a href>`, `useRoute()`. `projectRoute` mirrors the route into `useApp` for classic code; `bindLegacyWrites` turns classic `useApp` writes into navigations.
- `layout.ts`: `stack` (< 720px, pushed screens), `split` (< 1180px), `full`. Phone chrome keys off `useCoarse()`, not width.
- `ui/primitives.tsx`: `IconButton` (with tooltip + shortcut), `Segmented` (sliding pill), `Switch`, `Menu` + `useMenu` (popover, or sheet on touch), `Dialog`, `Kbd`, `Spinner`, `Portal`.
- `ui/Avatar.tsx` (presence dot / live ring), `ui/icons.tsx` (project icon set + additions), `hooks.ts` (`useNow`, `useHold`, `useOpenDirect`, `openPalette`), `format.ts` (dates in the viewer's timezone).

## Sections

`sections/index.ts` maps each section to a lazy `sections/<name>/index.tsx` that receives `SectionProps` (`route`, `layout`, `stack`). A section owns its folder: components, CSS (`<name>.css`, classes `nx-<name>-*`), and `strings.ts`. A section that is not rebuilt yet renders its classic screen through `ClassicFrame`.

## Local verification

The redesign can run against a throwaway local backend:

1. Postgres + Redis in the `default` Colima profile (never the `circlechat` one), migrate with `npx tsx server/src/migrate-bin.ts`, start `npx tsx server/src/index.ts` with `DATABASE_URL`, `REDIS_URL` and a dummy `OPENAI_API_KEY`. The server seeds demo agents and rooms on first boot.
2. Mint a session with `createSession` from `server/src/auth.ts` and open `/next#token=<token>&companyId=personal`.
3. Live states (typing, streaming, working) can be driven from the browser console in dev: `(await import('/src/stores/messages.ts')).useMessages.setState(...)`.
