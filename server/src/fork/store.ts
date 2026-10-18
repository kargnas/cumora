/**
 * The fork's own SQLite database, for data upstream cumora does not have.
 * Upstream's Postgres schema and migrations stay untouched, so merging
 * upstream never conflicts with fork-only tables.
 *
 * sql.js (SQLite compiled to WebAssembly) because the server image runs
 * Node 20, which has no node:sqlite, and a native module would also have to
 * be rebuilt for the Electron app that shares package.json.
 */
import initSqlJs from 'sql.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface RoomCategory { id: string; name: string; position: number; hidden: boolean }

/** One user's chat-list layout inside one company. */
export interface RoomLayout {
  /** Ordered by position. */
  categories: RoomCategory[]
  /** conversationId -> categoryId; rooms without an entry sit in no category. */
  rooms: Record<string, string>
  /** Collapsed group keys: category ids or the client's built-in section key. */
  collapsed: string[]
  /** Pinned rooms in the order this user arranged their tiles. Pinning itself is
   *  upstream's shared conversations.pinned column; only the order is personal. */
  pinOrder: string[]
}

// Same convention as UPLOAD_DIR in storage.ts: relative to the server's cwd
// (/app in the image), where compose mounts a volume so the file survives
// rebuilds.
export const FORK_DB_FILE = resolve(process.cwd(), 'server/data/fork.sqlite')

// Every write rewrites the whole file on the API process (see save below), so
// one user must not be able to grow it without bound.
export const MAX_CATEGORIES = 100
export const MAX_ROOM_ASSIGNMENTS = 5000
export const MAX_PIN_ORDER = 500
// The client's built-in section (OTHER_GROUP in src/next/chat/roomLayout.ts);
// every other collapsed key is a category id.
const BUILT_IN_GROUPS = ['other']

/** A write would take a user past MAX_CATEGORIES or MAX_ROOM_ASSIGNMENTS. */
export class ForkLimitError extends Error {}

// MIGRATIONS[n] upgrades the schema from version n to n + 1, and
// PRAGMA user_version records how many have run. Add later fork tables as new
// entries; never edit one that has shipped.
const MIGRATIONS = [
  `CREATE TABLE room_categories (
     id TEXT PRIMARY KEY,
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     -- REAL so a client can later insert between two neighbours without renumbering.
     position REAL NOT NULL
   );
   CREATE INDEX room_categories_owner ON room_categories (company_id, user_id);
   CREATE TABLE room_assignments (
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     category_id TEXT NOT NULL,
     PRIMARY KEY (company_id, user_id, conversation_id)
   );
   CREATE TABLE collapsed_groups (
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     group_key TEXT NOT NULL,
     PRIMARY KEY (company_id, user_id, group_key)
   );`,

  // The client dropped its 'former' section; its collapsed rows would stay
  // behind as keys nothing reads.
  `DELETE FROM collapsed_groups WHERE group_key = 'former';`,

  // Categories the user put out of sight, and the order of their pinned tiles.
  `ALTER TABLE room_categories ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE pin_order (
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     PRIMARY KEY (company_id, user_id, conversation_id)
   );`,

  // Versions of the computer's standing files, for the Handbook (./recorder.ts).
  // Rows are scoped by the agent whose home holds the file, not by company:
  // agent ids are unique across workspaces (participants_agent_id_unique), and
  // the handbook route checks the agent is the viewer's. Scope '' is the
  // computer's shared skills folder, read by every agent on it.
  `CREATE TABLE computer_file_versions (
     id INTEGER PRIMARY KEY,
     scope TEXT NOT NULL,
     -- Relative to the agent's home, or to the shared skills folder.
     path TEXT NOT NULL,
     -- ISO time of the change: the file's mtime, or when a deletion was seen.
     at TEXT NOT NULL,
     -- NULL: the file was deleted.
     content TEXT,
     -- 1 for the first version seen of a file that was there before its home
     -- was watched: what it held then, not a change.
     baseline INTEGER NOT NULL
   );
   CREATE INDEX computer_file_versions_file ON computer_file_versions (scope, path, at);`,
]

export interface FileVersion {
  id: number
  scope: string
  path: string
  at: string
  content: string | null
  baseline: boolean
}

export type NewFileVersion = Omit<FileVersion, 'id'>

export async function openForkStore(file: string) {
  const SQL = await initSqlJs()
  mkdirSync(dirname(file), { recursive: true })
  // What the file holds right now: a failed save puts memory back to this.
  let saved: Uint8Array | undefined = existsSync(file) ? readFileSync(file) : undefined
  let db = new SQL.Database(saved)

  const rows = (sql: string, params: initSqlJs.BindParams): initSqlJs.SqlValue[][] =>
    db.exec(sql, params)[0]?.values ?? []

  // sql.js keeps the database in memory, so every change is written out as a
  // whole new file and renamed over the old one: a crash mid-write leaves the
  // previous file intact instead of a half-written one.
  // ponytail: rewrites the whole file per change. Fine while it stays at a few
  // MB: layout rows plus the Handbook's file versions, which start at the
  // computer's standing files (under 1 MB) and keep every later version in
  // full. Switch to node:sqlite once the image runs Node 22+, or prune old
  // versions, before the file outgrows that.
  // When the write fails, the change is undone in memory too, so a later read
  // (the client resyncs after a failed write) never serves a state the file
  // does not have, and the next save does not persist it by accident.
  const save = () => {
    const bytes = db.export()
    try {
      writeFileSync(`${file}.tmp`, bytes)
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      db = new SQL.Database(saved)
      throw err
    }
    saved = bytes
  }

  const ownsCategory = (companyId: string, userId: string, id: string) =>
    rows('SELECT 1 FROM room_categories WHERE id = ? AND company_id = ? AND user_id = ?', [id, companyId, userId]).length > 0

  const VERSION_COLUMNS = 'id, scope, path, at, content, baseline'
  const toVersion = ([id, scope, path, at, content, baseline]: initSqlJs.SqlValue[]): FileVersion => ({
    id: Number(id), scope: String(scope), path: String(path), at: String(at),
    content: content === null ? null : String(content), baseline: Number(baseline) === 1,
  })
  // The version a file had at a time: its newest one at or before it. Versions
  // of one file never go back in time (the recorder clamps them), so `at`
  // orders them, and the id breaks a tie.
  const VERSION_AT = `SELECT w.id FROM computer_file_versions w
                       WHERE w.scope = v.scope AND w.path = v.path AND w.at <= ?
                       ORDER BY w.at DESC, w.id DESC LIMIT 1`

  const version = Number(rows('PRAGMA user_version', null)[0]?.[0] ?? 0)
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec(`BEGIN; ${MIGRATIONS[v]} PRAGMA user_version = ${v + 1}; COMMIT;`)
  }
  if (version < MIGRATIONS.length) save()

  // Foreign keys are not used: db.export() closes and reopens the database,
  // which resets PRAGMA foreign_keys, so related rows are removed explicitly.
  return {
    layout(companyId: string, userId: string): RoomLayout {
      const owner = [companyId, userId]
      return {
        categories: rows(
          `SELECT id, name, position, hidden FROM room_categories
            WHERE company_id = ? AND user_id = ? ORDER BY position, id`,
          owner,
        ).map(([id, name, position, hidden]) => ({ id: String(id), name: String(name), position: Number(position), hidden: Number(hidden) === 1 })),
        rooms: Object.fromEntries(
          rows('SELECT conversation_id, category_id FROM room_assignments WHERE company_id = ? AND user_id = ?', owner)
            .map(([conversationId, categoryId]) => [String(conversationId), String(categoryId)]),
        ),
        collapsed: rows('SELECT group_key FROM collapsed_groups WHERE company_id = ? AND user_id = ?', owner)
          .map(([key]) => String(key)),
        pinOrder: rows('SELECT conversation_id FROM pin_order WHERE company_id = ? AND user_id = ? ORDER BY position', owner)
          .map(([id]) => String(id)),
      }
    },

    createCategory(companyId: string, userId: string, name: string): RoomCategory {
      const count = Number(rows(
        'SELECT COUNT(*) FROM room_categories WHERE company_id = ? AND user_id = ?',
        [companyId, userId],
      )[0][0])
      if (count >= MAX_CATEGORIES) throw new ForkLimitError(`at most ${MAX_CATEGORIES} categories per user`)
      const id = randomUUID()
      const position = Number(rows(
        'SELECT COALESCE(MAX(position), 0) + 1 FROM room_categories WHERE company_id = ? AND user_id = ?',
        [companyId, userId],
      )[0][0])
      db.run(
        'INSERT INTO room_categories (id, company_id, user_id, name, position) VALUES (?, ?, ?, ?, ?)',
        [id, companyId, userId, name, position],
      )
      save()
      return { id, name, position, hidden: false }
    },

    updateCategory(companyId: string, userId: string, id: string, patch: { name?: string; position?: number; hidden?: boolean }): boolean {
      db.run(
        `UPDATE room_categories
            SET name = COALESCE(?, name), position = COALESCE(?, position), hidden = COALESCE(?, hidden)
          WHERE id = ? AND company_id = ? AND user_id = ?`,
        [patch.name ?? null, patch.position ?? null, patch.hidden === undefined ? null : Number(patch.hidden), id, companyId, userId],
      )
      if (db.getRowsModified() === 0) return false
      save()
      return true
    },

    deleteCategory(companyId: string, userId: string, id: string): boolean {
      db.run('DELETE FROM room_categories WHERE id = ? AND company_id = ? AND user_id = ?', [id, companyId, userId])
      if (db.getRowsModified() === 0) return false
      db.run('DELETE FROM room_assignments WHERE category_id = ? AND company_id = ? AND user_id = ?', [id, companyId, userId])
      // A category's collapsed state is stored under its id as the group key.
      db.run('DELETE FROM collapsed_groups WHERE group_key = ? AND company_id = ? AND user_id = ?', [id, companyId, userId])
      save()
      return true
    },

    /** null takes the room out of its category. False when the category is not this user's. */
    setRoomCategory(companyId: string, userId: string, conversationId: string, categoryId: string | null): boolean {
      if (categoryId === null) {
        db.run(
          'DELETE FROM room_assignments WHERE company_id = ? AND user_id = ? AND conversation_id = ?',
          [companyId, userId, conversationId],
        )
      } else {
        if (!ownsCategory(companyId, userId, categoryId)) return false
        // Moving a room that already has a category does not add a row.
        const others = Number(rows(
          'SELECT COUNT(*) FROM room_assignments WHERE company_id = ? AND user_id = ? AND conversation_id <> ?',
          [companyId, userId, conversationId],
        )[0][0])
        if (others >= MAX_ROOM_ASSIGNMENTS) {
          throw new ForkLimitError(`at most ${MAX_ROOM_ASSIGNMENTS} rooms can be in categories`)
        }
        db.run(
          `INSERT OR REPLACE INTO room_assignments (company_id, user_id, conversation_id, category_id)
           VALUES (?, ?, ?, ?)`,
          [companyId, userId, conversationId, categoryId],
        )
      }
      save()
      return true
    },

    /** Replaces this user's tile order. Ids of rooms that are not pinned do no
     *  harm (the client only sorts pinned rooms by it), so they are not checked. */
    setPinOrder(companyId: string, userId: string, conversationIds: string[]): void {
      if (conversationIds.length > MAX_PIN_ORDER) throw new ForkLimitError(`at most ${MAX_PIN_ORDER} pinned rooms can be ordered`)
      db.run('DELETE FROM pin_order WHERE company_id = ? AND user_id = ?', [companyId, userId])
      conversationIds.forEach((id, position) => {
        db.run('INSERT INTO pin_order (company_id, user_id, conversation_id, position) VALUES (?, ?, ?, ?)', [companyId, userId, id, position])
      })
      save()
    },

    /** False when the key is neither the built-in section nor one of this user's categories. */
    setCollapsed(companyId: string, userId: string, groupKey: string, collapsed: boolean): boolean {
      if (!BUILT_IN_GROUPS.includes(groupKey) && !ownsCategory(companyId, userId, groupKey)) return false
      db.run(
        collapsed
          ? 'INSERT OR IGNORE INTO collapsed_groups (company_id, user_id, group_key) VALUES (?, ?, ?)'
          : 'DELETE FROM collapsed_groups WHERE company_id = ? AND user_id = ? AND group_key = ?',
        [companyId, userId, groupKey],
      )
      save()
      return true
    },

    /** The newest version of every file ever recorded, tombstones included. */
    latestFileVersions(): FileVersion[] {
      return rows(
        `SELECT ${VERSION_COLUMNS} FROM computer_file_versions v
          WHERE id = (SELECT w.id FROM computer_file_versions w
                       WHERE w.scope = v.scope AND w.path = v.path
                       ORDER BY w.at DESC, w.id DESC LIMIT 1)`,
        null,
      ).map(toVersion)
    },

    /** Adds the versions in one write: the recorder hands over one poll's worth. */
    recordFileVersions(versions: NewFileVersion[]): void {
      if (versions.length === 0) return
      db.run('BEGIN')
      try {
        for (const v of versions) {
          db.run(
            'INSERT INTO computer_file_versions (scope, path, at, content, baseline) VALUES (?, ?, ?, ?, ?)',
            [v.scope, v.path, v.at, v.content, v.baseline ? 1 : 0],
          )
        }
        db.run('COMMIT')
      } catch (err) {
        db.run('ROLLBACK')
        throw err
      }
      save()
    },

    /** Every file of these scopes from the version it had at `since` on, or its
     *  whole history when `since` is null. Ordered by file, then time. */
    fileVersions(scopes: string[], since: string | null): FileVersion[] {
      if (scopes.length === 0) return []
      const inScopes = `scope IN (${scopes.map(() => '?').join(', ')})`
      return rows(
        since === null
          ? `SELECT ${VERSION_COLUMNS} FROM computer_file_versions WHERE ${inScopes} ORDER BY scope, path, at, id`
          : `SELECT ${VERSION_COLUMNS} FROM computer_file_versions v
              WHERE ${inScopes} AND (at > ? OR id = (${VERSION_AT}))
              ORDER BY scope, path, at, id`,
        since === null ? scopes : [...scopes, since, since],
      ).map(toVersion)
    },

    /** Agents whose home has had a recorded file: the ones on this computer. */
    fileScopes(): string[] {
      return rows("SELECT DISTINCT scope FROM computer_file_versions WHERE scope <> '' ORDER BY scope", null)
        .map(([scope]) => String(scope))
    },
  }
}

export type ForkStore = Awaited<ReturnType<typeof openForkStore>>

let shared: Promise<ForkStore> | undefined

/** The server's store at FORK_DB_FILE, opened on first use. A failed open is
 *  logged and not cached, so the next request tries again instead of every
 *  /api/fork call failing until a restart. `file` is for tests. */
export function getForkStore(file = FORK_DB_FILE): Promise<ForkStore> {
  return (shared ??= openForkStore(file).catch((err: unknown) => {
    shared = undefined
    console.error(`[fork] cannot open ${file}; /api/fork fails until it opens:`, err)
    throw err
  }))
}
