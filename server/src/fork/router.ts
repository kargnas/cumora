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

  // Other errors (requireCompany's HttpError, store failures) fall through to
  // the API's global errorHandler.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ForkError) { res.status(err.status).json({ error: err.message }); return }
    if (err instanceof ForkLimitError) { res.status(400).json({ error: err.message }); return }
    next(err)
  })
  return router
}
