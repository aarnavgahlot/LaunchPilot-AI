import express, { type ErrorRequestHandler } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config } from './config.js'
import { safeError } from './errors.js'
import { ZodError } from 'zod'
import { makeRouter } from './routes.js'
import { JsonRunStore } from './store.js'
import { ToolRegistry } from './tools/registry.js'
import { MockLlmProvider, OpenAiLlmProvider } from './provider/llm.js'
import { PlanningService } from './services/planning.js'
import { VerificationService } from './services/verification.js'
import { ExecutionService } from './services/execution.js'
import { ApprovalService } from './services/approval.js'
import { AgentService } from './services/agent.js'
import { GitHubConnectionService } from './github/connection.js'

const app = express()
app.disable('x-powered-by')
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
const trustedOrigins = config.CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean)
app.use(cors({ origin: (origin, callback) => callback(null, !origin || trustedOrigins.includes(origin)), credentials: false }))
app.use(express.json({ limit: '32kb', strict: true }))
app.use('/api', rateLimit({ windowMs: 60_000, limit: config.RUN_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false }))

const store = new JsonRunStore(resolve(config.DATA_DIR))
const github = new GitHubConnectionService(config)
const tools = new ToolRegistry({ mockMode: config.GITHUB_MODE === 'mock', github })
const provider = config.LLM_MODE === 'openai' ? new OpenAiLlmProvider(config, tools) : new MockLlmProvider()
const planning = new PlanningService(store, tools, provider, config)
const verification = new VerificationService(tools, config)
const execution = new ExecutionService(store, tools, verification, config)
const approvals = new ApprovalService(store, execution)
const agent = new AgentService(store, planning, execution, approvals, provider, config)

app.use('/api', makeRouter(agent, store, config, github))
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }))
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const safe = error instanceof ZodError
    ? { statusCode: 400, code: 'VALIDATION_ERROR', message: 'The request path or body is invalid.' }
    : safeError(error)
  res.status(safe.statusCode).json({ error: { code: safe.code, message: safe.message } })
}
app.use(errorHandler)

if (config.NODE_ENV !== 'test') {
  await mkdir(resolve(config.DATA_DIR), { recursive: true })
  await agent.recoverInterruptedRuns()
  app.listen(config.PORT, '127.0.0.1', () => console.info(`LaunchPilot API listening on 127.0.0.1:${config.PORT} (LLM=${config.LLM_MODE}, GitHub=${config.GITHUB_MODE})`))
}

export { app }
