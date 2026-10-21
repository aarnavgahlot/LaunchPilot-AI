import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '../errors.js'
import type { AppConfig } from '../config.js'
import type { AgentRun, Repository } from '../domain.js'
import { JsonRunStore, MemoryRunStore } from '../store.js'
import { transition } from '../stateMachine.js'
import { ToolRegistry } from '../tools/registry.js'
import { MockLlmProvider } from '../provider/llm.js'
import { PlanningService } from '../services/planning.js'
import { VerificationService } from '../services/verification.js'
import { ExecutionService } from '../services/execution.js'
import { ApprovalService } from '../services/approval.js'
import { AgentService } from '../services/agent.js'

const repository: Repository = { owner: 'acme', name: 'docs' }
function makeConfig(overrides: Partial<AppConfig> = {}) {
  return {
    NODE_ENV: 'test', PORT: 3001, DATA_DIR: './data', LLM_MODE: 'mock', OPENAI_API_KEY: undefined, OPENAI_MODEL: 'gpt-5.5',
    GITHUB_MODE: 'mock', GITHUB_APP_CONTENTS_WRITE: 'false',
    CORS_ORIGIN: 'http://localhost:5173', REQUEST_TIMEOUT_MS: 1500, RUN_RATE_LIMIT: 30, ...overrides,
  } as AppConfig
}
function makeServices(overrides: Partial<AppConfig> = {}) {
  const config = makeConfig(overrides)
  const store = new MemoryRunStore()
  const github = config.GITHUB_MODE === 'live' ? {
    assertRepository: async (owner: string, name: string) => ({ repository: { owner, name }, token: 'test-token' }),
    request: async (path: string, init?: RequestInit) => {
      const response = await fetch(`https://api.github.com${path}`, init)
      if (!response.ok) throw new AppError(502, 'GITHUB_API_ERROR', 'The GitHub request could not be completed.')
      return response.json()
    },
  } as never : undefined
  const tools = new ToolRegistry({ mockMode: config.GITHUB_MODE === 'mock', github })
  const provider = new MockLlmProvider()
  const planning = new PlanningService(store, tools, provider, config)
  const verification = new VerificationService(tools, config)
  const execution = new ExecutionService(store, tools, verification, config)
  const approvals = new ApprovalService(store, execution)
  const agent = new AgentService(store, planning, execution, approvals, provider, config)
  return { config, store, tools, provider, planning, verification, execution, approvals, agent }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('run state machine and planning', () => {
  it('accepts valid transitions and rejects invalid transitions', () => {
    expect(transition('queued', 'planning')).toBe('planning')
    expect(() => transition('completed', 'executing')).toThrow(/Invalid run state transition/)
  })

  it('asks for essential repository context before planning', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Review the project README and report gaps.' })
    expect(run.state).toBe('awaiting_input')
    expect(run.clarificationQuestion).toMatch(/Which GitHub repository/)
    const resumed = await agent.continue(run.id, repository)
    expect(resumed.repository).toEqual(repository)
    expect(resumed.plan?.steps.length).toBeGreaterThan(0)
  })

  it('selects only registered safe tools while planning and classifies consequential steps', async () => {
    const { agent, tools } = makeServices()
    const run = await agent.create({ goal: 'Review the README and create an issue for documentation gaps.', repository })
    expect(tools.modelTools().map(tool => tool.name)).toEqual(['inspect_repository', 'read_repository_file', 'list_repository_issues', 'list_repository_pull_requests', 'inspect_repository_structure'])
    const writeStep = run.plan?.steps.find(step => step.toolName === 'create_github_issue')
    expect(writeStep).toMatchObject({ risk: 'high', permission: 'issue:write', requiresApproval: true, status: 'awaiting_approval' })
    expect(run.state).toBe('awaiting_approval')
  })

  it('does not infer a write request from a request to review open issues', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Review the README, missing docs, open issues, and submission readiness.', repository })
    expect(run.state).toBe('completed')
    expect(run.plan?.steps.some(step => step.toolName === 'create_github_issue')).toBe(false)
  })

  it('enforces read-only mode for consequential actions on the server', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Review the docs and create a GitHub issue for missing setup instructions.', repository, readOnly: true })
    const issue = run.plan?.steps.find(step => step.toolName === 'create_github_issue')
    expect(issue).toMatchObject({ status: 'skipped', requiresApproval: false })
    expect(run.events.some(event => event.type === 'action_skipped_read_only')).toBe(true)
    expect(run.decisions).toHaveLength(0)
    expect(run.plan?.steps.some(step => step.status === 'awaiting_approval')).toBe(false)
  })
})

describe('tool validation and approval', () => {
  it('keeps failed read-back verification separate from tool success', async () => {
    const config = makeConfig({ GITHUB_MODE: 'live' })
    const github = { assertRepository: async (owner: string, name: string) => ({ repository: { owner, name }, token: 'test-token' }), request: async () => ({ number: 51, title: 'Unexpected issue', state: 'open', url: 'https://github.com/acme/docs/issues/51' }) } as never
    const tools = new ToolRegistry({ mockMode: false, github })
    const verification = new VerificationService(tools, config)
    const run: AgentRun = { id: 'run_00000000-0000-4000-8000-000000000001', goal: 'Verify exact issue', repository, state: 'verifying', mode: 'mock', githubMode: 'live', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], verifications: [], decisions: [], continuationCount: 0, plan: { title: 'Verify issue', summary: 'Check issue evidence.', clarificationQuestion: null, steps: [{ id: 'create', title: 'Create issue', description: 'Create an issue.', toolName: 'create_github_issue', risk: 'high', permission: 'issue:write', additionalPermissions: [], requiresApproval: true, status: 'succeeded', result: { number: 52, title: 'Expected issue', marker: '<!-- launchpilot-action:run -->' } }] } }
    const result = await verification.verifyIssue(run, 52)
    expect(result.status).toBe('failed')
    expect(result.verifiedAt).toBeTruthy()
    expect(result.evidence).toMatchObject({ number: 51, url: 'https://github.com/acme/docs/issues/51' })
  })

  it('rejects invalid file arguments and blocks unapproved writes', async () => {
    const { tools, config } = makeServices()
    const context = { config, repository, runId: 'run_security' }
    await expect(tools.execute('read_repository_file', { ...repository, path: '../../.env' }, context)).rejects.toMatchObject({ code: 'FILE_NOT_ALLOWED' })
    await expect(tools.execute('read_repository_file', { ...repository, path: 5 }, context)).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    await expect(tools.execute('create_github_issue', { ...repository, title: 'A valid issue title', body: 'Details' }, context)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(tools.execute('create_documentation_pull_request', { ...repository, path: '../../README.md', content: '# Draft', title: 'Improve the README', body: 'Review the proposed documentation.' }, context)).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    await expect(tools.execute('create_documentation_pull_request', { ...repository, path: 'README.md', content: '# Draft', title: 'Improve the README', body: 'Review the proposed documentation.' }, context)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })

  it('executes an approved write and verifies through a separate read tool', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Review docs and create an issue for the missing contribution guide.', repository })
    const pending = run.plan!.steps.find(step => step.requiresApproval)!
    const updated = await agent.decide(run.id, pending.id, pending.approvalDigest!, 'approve')
    expect(updated.state).toBe('completed')
    expect(updated.plan?.steps.find(step => step.id === pending.id)?.status).toBe('succeeded')
    expect(updated.plan?.steps.find(step => step.id === pending.id)?.result).toMatchObject({ mode: 'mock', writePerformed: false })
    expect(updated.verifications.find(item => item.label === 'GitHub issue exists')).toMatchObject({ status: 'inconclusive' })
    expect(updated.goalStatus).toBe('unverified')
    expect(updated.events.some(event => event.type === 'approval_granted')).toBe(true)
  })

  it('keeps a confirmed write successful when read-back verification is unavailable', async () => {
    const { agent, verification } = makeServices()
    vi.spyOn(verification, 'verifyIssue').mockRejectedValue(new AppError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached. Check the connection and retry.'))
    const run = await agent.create({ goal: 'Create a GitHub issue for missing docs after reviewing the README.', repository })
    const pending = run.plan!.steps.find(step => step.requiresApproval)!
    const updated = await agent.decide(run.id, pending.id, pending.approvalDigest!, 'approve')
    expect(updated.plan?.steps.find(step => step.id === pending.id)?.status).toBe('succeeded')
    expect(updated.state).toBe('completed')
    expect(updated.goalStatus).toBe('unverified')
    expect(updated.verifications.find(item => item.label === 'GitHub issue exists')).toMatchObject({ status: 'inconclusive', detail: expect.stringContaining('read-back verification was unavailable') })
  })

  it('retries only an inconclusive write verification without repeating the write', async () => {
    const { agent, verification, tools } = makeServices()
    let verificationCalls = 0
    vi.spyOn(verification, 'verifyIssue').mockImplementation(async (run, number) => {
      verificationCalls += 1
      if (verificationCalls === 1) throw new AppError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached. Check the connection and retry.')
      return { id: 'retry-verification', label: 'GitHub issue exists', status: 'inconclusive', detail: 'Simulated verification only.', verifiedAt: new Date().toISOString() }
    })
    const execute = vi.spyOn(tools, 'execute')
    const run = await agent.create({ goal: 'Create a GitHub issue for missing docs after reviewing the README.', repository })
    const pending = run.plan!.steps.find(step => step.requiresApproval)!
    const first = await agent.decide(run.id, pending.id, pending.approvalDigest!, 'approve')
    expect(first.state).toBe('completed')
    expect(first.goalStatus).toBe('unverified')
    const retried = await agent.continue(run.id)
    expect(retried.state).toBe('completed')
    expect(verificationCalls).toBe(2)
    expect(execute.mock.calls.filter(([name]) => name === 'create_github_issue')).toHaveLength(1)
    expect(retried.events.some(event => event.type === 'verification_retry_started')).toBe(true)
  })

  it('records a rejection without executing the write tool', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Create an issue for missing docs after reviewing the README.', repository })
    const pending = run.plan!.steps.find(step => step.requiresApproval)!
    const updated = await agent.decide(run.id, pending.id, pending.approvalDigest!, 'reject')
    expect(updated.state).toBe('partially_completed')
    expect(updated.plan?.steps.find(step => step.id === pending.id)?.status).toBe('rejected')
    expect(updated.plan?.steps.find(step => step.id === pending.id)?.result).toBeUndefined()
    await expect(agent.decide(run.id, pending.id, pending.approvalDigest!, 'approve')).rejects.toMatchObject({ code: 'RUN_NOT_AWAITING_APPROVAL' })
    expect(updated.goalStatus).toBe('partially_achieved')
  })

  it('rejects an approval when the target or payload changed after the review was presented', async () => {
    const { agent, store } = makeServices()
    const run = await agent.create({ goal: 'Create an issue for missing docs after reviewing the README.', repository })
    const pending = run.plan!.steps.find(step => step.requiresApproval)!
    const changed = (await store.get(run.id))!
    changed.goal += ' Include setup clarity.'
    await store.save(changed)
    await expect(agent.decide(run.id, pending.id, pending.approvalDigest!, 'approve')).rejects.toMatchObject({ code: 'APPROVAL_STALE' })
    const refreshed = await agent.get(run.id)
    const updatedAction = refreshed.plan!.steps.find(step => step.id === pending.id)!
    expect(updatedAction.approvalDigest).not.toBe(pending.approvalDigest)
    expect(updatedAction.approvalPreview).toMatchObject({ body: expect.stringContaining('Include setup clarity.') })
    const approved = await agent.decide(run.id, pending.id, updatedAction.approvalDigest!, 'approve')
    expect(approved.plan?.steps.find(step => step.id === pending.id)?.status).toBe('succeeded')
  })

  it('requires approval before a proposed documentation branch and pull request', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Review the README and create a documentation pull request for submission readiness.', repository })
    const step = run.plan?.steps.find(candidate => candidate.toolName === 'create_documentation_pull_request')
    expect(run.state).toBe('awaiting_approval')
    expect(step).toMatchObject({ status: 'awaiting_approval', permission: 'contents:write', requiresApproval: true })
    expect(step?.description).toContain('Target: acme/docs')
    expect(step?.approvalPreview).toMatchObject({ owner: 'acme', name: 'docs', path: 'README.md' })
    expect(JSON.stringify(run.events)).not.toContain('proposedContent')
    const persistedReadme = run.plan?.steps.find(candidate => candidate.toolName === 'read_repository_file')?.result
    expect(persistedReadme).toMatchObject({ contentOmitted: true })
  })
})

describe('failures, retries, and cancellation', () => {
  it('returns the existing run for a repeated idempotency key', async () => {
    const { agent } = makeServices()
    const input = { goal: 'Review this project README and report documentation gaps.', repository }
    const first = await agent.create(input, 'duplicate-request-001')
    const second = await agent.create(input, 'duplicate-request-001')
    expect(second.id).toBe(first.id)
  })

  it('recovers an interrupted tool step as retryable partial work', async () => {
    const { agent, store } = makeServices()
    const run = await agent.create({ goal: 'Review this project README and report documentation gaps.', repository })
    const first = (await store.get(run.id))!
    first.state = 'executing'
    first.plan!.steps[0]!.status = 'running'
    await store.save(first)
    await agent.recoverInterruptedRuns()
    const recovered = await agent.get(run.id)
    expect(recovered).toMatchObject({ state: 'partially_completed', goalStatus: 'partially_achieved' })
    expect(recovered.plan?.steps[0]).toMatchObject({ status: 'failed' })
    expect(recovered.events.some(event => event.type === 'run_recovered')).toBe(true)
  })

  it('retains successful steps and retries only failed tools', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/readme') && fetchMock.mock.calls.filter(([called]) => String(called).endsWith('/readme')).length === 1) return new Response('unavailable', { status: 503 })
      if (url.endsWith('/readme')) return new Response(JSON.stringify({ type: 'file', size: 16, path: 'README.md', encoding: 'base64', content: Buffer.from('# Docs').toString('base64') }), { status: 200 })
      if (url.includes('/issues?')) return new Response('[]', { status: 200 })
      if (url.includes('/pulls?')) return new Response('[]', { status: 200 })
      if (url.includes('/languages')) return new Response(JSON.stringify({ TypeScript: 100 }), { status: 200 })
      if (url.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'commit-1' } }), { status: 200 })
      if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ path: 'README.md', type: 'blob' }, { path: 'package.json', type: 'blob' }] }), { status: 200 })
      return new Response(JSON.stringify({ full_name: 'acme/docs', description: 'Docs', default_branch: 'main', private: false, open_issues_count: 0 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { agent } = makeServices({ GITHUB_MODE: 'live' })
    const failed = await agent.create({ goal: 'Review this project README for setup gaps.', repository })
    expect(failed.state).toBe('partially_completed')
    const failedSteps = failed.plan!.steps.filter(step => step.status === 'failed')
    expect(failedSteps.map(step => step.toolName)).toEqual(['read_repository_file'])
    const callsBeforeRetry = fetchMock.mock.calls.length
    const retried = await agent.continue(failed.id)
    expect(retried.state).toBe('completed')
    expect(retried.goalStatus).toBe('achieved')
    expect(retried.continuationCount).toBe(1)
    expect(fetchMock.mock.calls.length - callsBeforeRetry).toBe(1)
  })

  it('cancels a run paused for clarification and rejects later continuation', async () => {
    const { agent } = makeServices()
    const waiting = await agent.create({ goal: 'Review the repository contribution documentation.' })
    const cancelled = await agent.cancel(waiting.id)
    expect(cancelled.state).toBe('cancelled')
    await expect(agent.continue(waiting.id, repository)).rejects.toMatchObject({ code: 'RUN_NOT_CONTINUABLE' })
  })

  it('redacts credentials before they are persisted or passed to planning', async () => {
    const { agent } = makeServices()
    const run = await agent.create({ goal: 'Review README; token=example-secret-value and summarize.' })
    expect(run.goal).not.toContain('example-secret-value')
    expect(JSON.stringify(run.events)).not.toContain('example-secret-value')
  })

  it('persists runs atomically and can reload them in a new store instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'launchpilot-store-'))
    try {
      const run: AgentRun = { id: 'run_00000000-0000-4000-8000-000000000000', goal: 'Read the README', state: 'queued', mode: 'mock', githubMode: 'mock', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', events: [], verifications: [], decisions: [], continuationCount: 0 }
      await new JsonRunStore(directory).save(run)
      const loaded = await new JsonRunStore(directory).get(run.id)
      expect(loaded).toEqual(run)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
