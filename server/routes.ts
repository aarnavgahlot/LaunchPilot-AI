import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import type { AppConfig } from './config.js'
import { ApprovalSchema, CreateRunSchema, RepoSchema } from './domain.js'
import { AppError } from './errors.js'
import type { AgentService } from './services/agent.js'
import type { RunStore } from './store.js'
import type { GitHubConnectionService } from './github/connection.js'
import { randomBytes } from 'node:crypto'

const IdSchema = z.string().regex(/^run_[0-9a-f-]{36}$/i)
const ContinueSchema = z.object({ repository: RepoSchema.optional() }).strict()
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next) }

export function makeRouter(agent: AgentService, store: RunStore, config: AppConfig, github: GitHubConnectionService) {
  const router = Router()
  const trustedOrigins = config.CORS_ORIGIN.split(',').map(value => value.trim())
  router.use((req, _res, next) => {
    const origin = req.header('origin')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !trustedOrigins.includes(origin)) return next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This request did not come from the configured LaunchPilot origin.'))
    next()
  })
  router.get('/health', (_req, res) => res.json({ ok: true, service: 'launchpilot-api', llmMode: config.LLM_MODE, githubMode: config.GITHUB_MODE }))
  router.get('/integrations', asyncRoute(async (_req, res) => res.json({ data: [
    { id: 'github', name: 'GitHub', ...await github.status() },
    { id: 'llm', name: config.LLM_MODE === 'openai' ? 'OpenAI' : 'Deterministic planner', mode: config.LLM_MODE, status: config.LLM_MODE === 'openai' ? 'configured' : 'mock' },
  ] })))
  router.get('/integrations/github', asyncRoute(async (_req, res) => res.json({ data: await github.status() })))
  router.get('/integrations/github/repositories', asyncRoute(async (_req, res) => {
    const status = await github.status()
    if (!status.connected) throw new AppError(401, 'GITHUB_NOT_CONNECTED', 'Connect a GitHub account before selecting a repository.')
    res.json({ data: await github.listRepositories() })
  }))
  router.get('/integrations/github/connect', (_req, res) => {
    if (!github.isConfigured) throw new AppError(409, 'GITHUB_MOCK_MODE', 'GitHub App credentials are not configured. Follow the setup guide to enable live integration.')
    const state = randomBytes(32).toString('hex')
    github.setStateCookie(res, state)
    res.redirect(302, github.authorizationUrl(state))
  })
  router.get('/integrations/github/callback', asyncRoute(async (req, res) => {
    const code = z.string().min(1).max(256).safeParse(req.query.code)
    const state = z.string().regex(/^[0-9a-f]{64}$/).safeParse(req.query.state)
    if (!code.success || !state.success || req.query.error) throw new AppError(400, 'GITHUB_OAUTH_DENIED', 'GitHub authorization was cancelled or returned invalid details.')
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')).filter(pair => pair.length === 2).map(([name, value]) => {
      try { return [decodeURIComponent(name), decodeURIComponent(value)] }
      catch { return ['', ''] }
    }).filter(([name]) => Boolean(name)))
    await github.completeOAuth(code.data, state.data, cookies.launchpilot_github_oauth_state)
    res.clearCookie('launchpilot_github_oauth_state', { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', path: '/api/integrations/github' })
    res.redirect(302, '/?github=connected')
  }))
  router.post('/integrations/github/disconnect', asyncRoute(async (_req, res) => { await github.disconnect(); res.json({ data: await github.status() }) }))
  router.get('/runs', asyncRoute(async (_req, res) => res.json({ data: await agent.list() })))
  router.post('/runs', asyncRoute(async (req, res) => {
    const parsed = CreateRunSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
    const rawKey = req.header('idempotency-key')
    if (rawKey && !/^[a-zA-Z0-9._:-]{8,128}$/.test(rawKey)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8 to 128 safe characters.')
    const run = await agent.submit(parsed.data, rawKey)
    res.status(202).json({ data: run })
  }))
  router.get('/runs/:id', asyncRoute(async (req, res) => { const run = await agent.get(IdSchema.parse(req.params.id)); res.json({ data: run }) }))
  router.post('/runs/:id/approval', asyncRoute(async (req, res) => {
    const id = IdSchema.parse(req.params.id)
    const parsed = ApprovalSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Provide an actionId and approve or reject decision.')
    res.json({ data: await agent.decide(id, parsed.data.actionId, parsed.data.digest, parsed.data.decision) })
  }))
  router.post('/runs/:id/continue', asyncRoute(async (req, res) => {
    const id = IdSchema.parse(req.params.id)
    const parsed = ContinueSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'The continue request is invalid.')
    res.json({ data: await agent.continue(id, parsed.data.repository) })
  }))
  router.post('/runs/:id/cancel', asyncRoute(async (req, res) => res.json({ data: await agent.cancel(IdSchema.parse(req.params.id)) })))
  router.get('/runs/:id/events', asyncRoute(async (req, res) => res.json({ data: (await agent.get(IdSchema.parse(req.params.id))).events })))
  router.get('/runs/:id/verifications', asyncRoute(async (req, res) => res.json({ data: (await agent.get(IdSchema.parse(req.params.id))).verifications })))
  return router
}
