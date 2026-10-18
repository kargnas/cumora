import { Router, type Request, type Response, type NextFunction } from 'express'
import type { AuthedRequest } from '../auth.js'
import { ForkLimitError, getForkStore } from './store.js'
import { agentHandbook } from './handbook.js'
import { startRecorder } from './recorder.js'

type CompanyContext = { userId: string; companyId: string }

export interface ForkRouterDeps {
  requireCompany(req: Request & AuthedRequest): Promise<CompanyContext>
}

class ForkError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function categoryName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length < 1 || name.length > 60) throw new ForkError(400, 'name must be 1 to 60 characters')
  return name
}

function routeKey(value: string, label: string): string {
  if (value.length > 100) throw new ForkError(400, `${label} must be at most 100 characters`)
  return value
}

/** A bloub catalogue id. The client knows the catalogue and draws an unknown id
 *  as its default, so the server only keeps the value short and plain. */
function lookId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z]{1,24}$/.test(value)) throw new ForkError(400, `${label} must be 1 to 24 lowercase letters`)
  return value
}

/** Changing how an agent looks changes it for everyone in the workspace, so it
 *  takes the same bar as upstream's PUT /api/agents/:id: owner or admin. */
async function requireAgentEditor(companyId: string, userId: string, participantId: string): Promise<void> {
  // Imported here, not at the top: db/pool.js loads env.ts, which exits
  // without OPENAI_API_KEY and would kill the tests that import this module.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ kind: string | null; role: string | null }>(
    `SELECT (SELECT kind FROM participants WHERE id = $1 AND company_id = $2) AS kind,
            (SELECT role FROM company_members WHERE company_id = $2 AND user_id = $3) AS role`,
    [participantId, companyId, userId],
  )
  const role = rows[0]?.role
  if (role !== 'owner' && role !== 'admin') throw new ForkError(403, 'this action requires an owner or admin of the workspace')
  if (rows[0]?.kind !== 'agent') throw new ForkError(404, 'agent not found')
}

/** Fork-only endpoints under /api/fork, backed by the SQLite store in ./store.ts.
 *  Every row is scoped by the caller's own (companyId, userId) from requireCompany.
 *  Created once at boot, which is also when the Handbook's recorder starts. */
export function createForkRouter(deps: ForkRouterDeps): Router {
  const router = Router()
  startRecorder()

  router.get('/room-layout', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    res.json((await getForkStore()).layout(companyId, userId))
  })

  router.get('/agents/:agentId/handbook', (req, res) => agentHandbook(deps.requireCompany, req, res))

  router.post('/categories', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const name = categoryName(req.body?.name)
    res.status(201).json({ category: (await getForkStore()).createCategory(companyId, userId, name) })
  })

  router.patch('/categories/:id', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const body = req.body ?? {}
    const patch: { name?: string; position?: number; hidden?: boolean } = {}
    if (body.name !== undefined) patch.name = categoryName(body.name)
    if (body.position !== undefined) {
      if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
        throw new ForkError(400, 'position must be a finite number')
      }
      patch.position = body.position
    }
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== 'boolean') throw new ForkError(400, 'hidden must be a boolean')
      patch.hidden = body.hidden
    }
    if (!(await getForkStore()).updateCategory(companyId, userId, req.params.id, patch)) {
      throw new ForkError(404, 'category not found')
    }
    res.json({ ok: true })
  })

  router.delete('/categories/:id', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    if (!(await getForkStore()).deleteCategory(companyId, userId, req.params.id)) {
      throw new ForkError(404, 'category not found')
    }
    res.json({ ok: true })
  })

  router.put('/rooms/:conversationId/category', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const conversationId = routeKey(req.params.conversationId, 'conversationId')
    const categoryId: unknown = req.body?.categoryId
    if (categoryId !== null && typeof categoryId !== 'string') {
      throw new ForkError(400, 'categoryId must be a string or null')
    }
    if (!(await getForkStore()).setRoomCategory(companyId, userId, conversationId, categoryId)) {
      throw new ForkError(404, 'category not found')
    }
    res.json({ ok: true })
  })

  router.put('/pin-order', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const ids: unknown = req.body?.conversationIds
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new ForkError(400, 'conversationIds must be an array of strings')
    }
    if (new Set(ids).size !== ids.length) throw new ForkError(400, 'conversationIds must not repeat')
    const store = await getForkStore()
    store.setPinOrder(companyId, userId, ids.map((id) => routeKey(id, 'conversationId')))
    res.json({ ok: true })
  })

  router.put('/groups/:key/collapsed', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const key = routeKey(req.params.key, 'key')
    const collapsed: unknown = req.body?.collapsed
    if (typeof collapsed !== 'boolean') throw new ForkError(400, 'collapsed must be a boolean')
    if (!(await getForkStore()).setCollapsed(companyId, userId, key, collapsed)) {
      throw new ForkError(404, 'group not found')
    }
    res.json({ ok: true })
  })

  router.get('/bloub-avatars', async (req, res) => {
    const { companyId } = await deps.requireCompany(req)
    res.json({ avatars: (await getForkStore()).bloubAvatars(companyId) })
  })

  router.put('/bloub-avatars/:participantId', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const participantId = routeKey(req.params.participantId, 'participantId')
    const body = req.body ?? {}
    const look = {
      shape: lookId(body.shape, 'shape'),
      color: lookId(body.color, 'color'),
      expression: lookId(body.expression, 'expression'),
    }
    await requireAgentEditor(companyId, userId, participantId)
    const store = await getForkStore()
    store.setBloubAvatar(companyId, participantId, look)
    res.json({ ok: true })
  })

  router.delete('/bloub-avatars/:participantId', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const participantId = routeKey(req.params.participantId, 'participantId')
    await requireAgentEditor(companyId, userId, participantId)
    const store = await getForkStore()
    store.clearBloubAvatar(companyId, participantId)
    res.json({ ok: true })
  })

  // Other errors (requireCompany's HttpError, store failures) fall through to
  // the API's global errorHandler.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ForkError) { res.status(err.status).json({ error: err.message }); return }
    if (err instanceof ForkLimitError) { res.status(400).json({ error: err.message }); return }
    next(err)
  })
  return router
}
