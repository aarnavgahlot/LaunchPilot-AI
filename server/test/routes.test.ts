import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { makeRouter } from '../routes.js'
import { safeError } from '../errors.js'
import { MemoryRunStore } from '../store.js'
import type { AppConfig } from '../config.js'
import { ToolRegistry } from '../tools/registry.js'
import { MockLlmProvider } from '../provider/llm.js'
import { PlanningService } from '../services/planning.js'
import { VerificationService } from '../services/verification.js'
import { ExecutionService } from '../services/execution.js'
import { ApprovalService } from '../services/approval.js'
import { AgentService } from '../services/agent.js'
import { GitHubConnectionService } from '../github/connection.js'

const config = { NODE_ENV: 'test', PORT: 3001, DATA_DIR: './data', LLM_MODE: 'mock', OPENAI_API_KEY: undefined, OPENAI_MODEL: 'gpt-5.5', GITHUB_MODE: 'mock', GITHUB_APP_CONTENTS_WRITE: 'false', CORS_ORIGIN: 'http://localhost:5173', REQUEST_TIMEOUT_MS: 1500, RUN_RATE_LIMIT: 30 } as AppConfig

function buildApp() {
  const store = new MemoryRunStore()
  const github = new GitHubConnectionService(config)
  const tools = new ToolRegistry({ mockMode: true, github })
  const provider = new MockLlmProvider()
  const verification = new VerificationService(tools, config)
  const execution = new ExecutionService(store, tools, verification, config)
  const agent = new AgentService(store, new PlanningService(store, tools, provider, config), execution, new ApprovalService(store, execution), provider, config)
  const app = express()
  app.use(express.json())
  app.use('/api', makeRouter(agent, store, config, github))
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const safe = safeError(error); res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.message } }) })
  return app
}

describe('HTTP API', () => {
  it('validates run creation and returns persisted status, events, and verifications', async () => {
    const app = buildApp()
    const invalid = await request(app).post('/api/runs').send({ goal: 'short' })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR')
    const created = await request(app).post('/api/runs').send({ goal: 'Review documentation and report gaps.' })
    expect(created.status).toBe(202)
    expect(created.body.data.state).toBe('awaiting_input')
    const id = created.body.data.id as string
    expect((await request(app).get(`/api/runs/${id}`)).body.data.id).toBe(id)
    expect((await request(app).get(`/api/runs/${id}/events`)).body.data.map((item: { type: string }) => item.type)).toContain('clarification_requested')
    expect((await request(app).get(`/api/runs/${id}/verifications`)).body.data).toEqual([])
  })

  it('reuses a run for duplicate create requests and redacts credentials in the API response', async () => {
    const app = buildApp()
    const key = 'run-request-duplicate-01'
    const first = await request(app).post('/api/runs').set('Idempotency-Key', key).send({ goal: 'Review README token=example-secret-value and summarize.' })
    const retry = await request(app).post('/api/runs').set('Idempotency-Key', key).send({ goal: 'Review README token=example-secret-value and summarize.' })
    expect(first.status).toBe(202)
    expect(retry.body.data.id).toBe(first.body.data.id)
    expect(JSON.stringify(first.body)).not.toContain('example-secret-value')
  })

  it('accepts and enforces read-only mode through the run creation API', async () => {
    const app = buildApp()
    const response = await request(app).post('/api/runs').send({ goal: 'Review documentation and create an issue for missing setup steps.', repository: { owner: 'acme', name: 'docs' }, readOnly: true })
    expect(response.status).toBe(202)
    let run = response.body.data
    for (let attempt = 0; attempt < 40 && ['queued', 'planning', 'executing', 'verifying'].includes(run.state); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      run = (await request(app).get(`/api/runs/${run.id}`)).body.data
    }
    expect(run.readOnly).toBe(true)
    expect(run.plan.steps.find((step: { toolName: string }) => step.toolName === 'create_github_issue').status).toBe('skipped')
  })

  it('exposes explicit integration modes and validates approval decisions', async () => {
    const app = buildApp()
    const integrations = await request(app).get('/api/integrations')
    expect(integrations.body.data).toMatchObject([{ id: 'github', mode: 'mock', status: 'mock' }, { id: 'llm', mode: 'mock', status: 'mock' }])
    const invalid = await request(app).post('/api/runs/run_00000000-0000-4000-8000-000000000000/approval').send({ decision: 'yes' })
    expect(invalid.status).toBe(400)
    expect((await request(app).get('/api/integrations/github/repositories')).status).toBe(401)
    expect((await request(app).get('/api/integrations/github/connect')).status).toBe(409)
  })

  it('rejects cross-origin write requests for approval and connection actions', async () => {
    const response = await request(buildApp()).post('/api/integrations/github/disconnect').set('Origin', 'https://attacker.example')
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('ORIGIN_NOT_ALLOWED')
  })
})
