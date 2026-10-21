import type { AppConfig } from '../config.js'
import { newId, type AgentRun, type CreateRunInput, RepoSchema, type Repository } from '../domain.js'
import { AppError } from '../errors.js'
import { redactUntrusted } from '../security.js'
import { transition } from '../stateMachine.js'
import type { LlmProvider } from '../provider/llm.js'
import type { RunStore } from '../store.js'
import { ApprovalService } from './approval.js'
import { ExecutionService } from './execution.js'
import { PlanningService } from './planning.js'

export class AgentService {
  private locks = new Map<string, Promise<void>>()
  private scheduledRuns = new Set<string>()
  constructor(private readonly store: RunStore, private readonly planning: PlanningService, private readonly execution: ExecutionService, private readonly approvals: ApprovalService, private readonly provider: LlmProvider, private readonly config: AppConfig) {}
  async create(input: CreateRunInput, idempotencyKey?: string) {
    if (idempotencyKey) return this.exclusive(`create:${idempotencyKey}`, async () => {
      const existing = (await this.store.list()).find(run => run.idempotencyKey === idempotencyKey)
      return existing ?? this.createNew(input, idempotencyKey)
    })
    return this.createNew(input)
  }
  async submit(input: CreateRunInput, idempotencyKey?: string) {
    const run = idempotencyKey
      ? await this.exclusive(`create:${idempotencyKey}`, async () => (await this.store.list()).find(item => item.idempotencyKey === idempotencyKey) ?? this.createQueued(input, idempotencyKey))
      : await this.createQueued(input)
    if (run.state === 'queued' && run.repository) this.schedule(run.id)
    else if (!run.repository && run.state === 'queued') await this.planning.plan(run)
    return this.get(run.id)
  }
  private async createQueued(input: CreateRunInput, idempotencyKey?: string) {
    const now = new Date().toISOString()
    const run: AgentRun = { id: newId('run'), idempotencyKey, goal: redactUntrusted(input.goal), repository: input.repository, readOnly: input.readOnly ?? false, state: 'queued', mode: this.provider.mode, githubMode: this.config.GITHUB_MODE, createdAt: now, updatedAt: now, events: [], verifications: [], decisions: [], continuationCount: 0 }
    run.events.push({ id: newId('event'), at: now, type: 'run_created', message: `Run queued in explicit ${run.mode} provider mode.` })
    await this.store.save(run)
    return run
  }
  private schedule(id: string) {
    if (this.scheduledRuns.has(id)) return
    this.scheduledRuns.add(id)
    setTimeout(() => {
      void this.exclusive(id, async () => {
        const run = await this.get(id)
        if (run.state !== 'queued') return
        const planned = await this.planning.plan(run)
        if (planned.state !== 'failed' && planned.state !== 'awaiting_input') await this.execution.execute(planned)
      }).catch(async () => {
        const run = await this.get(id).catch(() => undefined)
        if (!run || ['completed', 'partially_completed', 'failed', 'cancelled'].includes(run.state)) return
        run.state = transition(run.state, 'failed')
        run.result = 'The background run stopped unexpectedly. Check the event log and retry failed steps.'
        run.updatedAt = new Date().toISOString()
        run.events.push({ id: newId('event'), at: run.updatedAt, type: 'run_worker_failed', message: run.result })
        await this.store.save(run)
      }).finally(() => { this.execution.clearCancellationRequest(id); this.scheduledRuns.delete(id) })
    }, 0)
  }
  private async createNew(input: CreateRunInput, idempotencyKey?: string) {
    const now = new Date().toISOString()
    const run: AgentRun = { id: newId('run'), idempotencyKey, goal: redactUntrusted(input.goal), repository: input.repository, readOnly: input.readOnly ?? false, state: 'queued', mode: this.provider.mode, githubMode: this.config.GITHUB_MODE, createdAt: now, updatedAt: now, events: [], verifications: [], decisions: [], continuationCount: 0 }
    await this.store.save(run)
    run.events.push({ id: newId('event'), at: now, type: 'run_created', message: `Run created in explicit ${run.mode} provider mode.` })
    await this.store.save(run)
    if (!run.repository) return this.planning.plan(run)
    const planned = await this.planning.plan(run)
    if (planned.state === 'failed') return planned
    return this.execution.execute(planned)
  }
  async get(id: string) { const run = await this.store.get(id); if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'The requested run was not found.'); return run }
  async list() { return this.store.list() }
  async recoverInterruptedRuns() {
    const active = new Set(['executing'])
    for (const run of await this.store.list()) {
      const interrupted = run.plan?.steps.filter(step => step.status === 'running') ?? []
      if (!active.has(run.state) || interrupted.length === 0) continue
      for (const step of interrupted) {
        step.status = 'failed'
        step.error = 'Execution was interrupted. A retry will check for an existing GitHub resource before writing again.'
      }
      run.executionLock = undefined
      run.state = 'partially_completed'
      run.goalStatus = 'partially_achieved'
      run.result = 'The server restarted during this run. Review failed steps and safely retry to recover.'
      run.updatedAt = new Date().toISOString()
      run.events.push({ id: newId('event'), at: run.updatedAt, type: 'run_recovered', message: 'Interrupted execution was recovered. Any write retry uses the action marker or deterministic branch to check for an existing result first.' })
      await this.store.save(run)
    }
  }
  async decide(id: string, actionId: string, digest: string, decision: 'approve' | 'reject') { return this.exclusive(id, async () => this.approvals.decide(await this.get(id), actionId, digest, decision)) }
  async continue(id: string, repoInput?: Repository) {
    return this.exclusive(id, () => this.continueLocked(id, repoInput))
  }
  private async continueLocked(id: string, repoInput?: Repository) {
    const run = await this.get(id)
    if (run.state === 'completed' && run.plan?.steps.some(step => step.status === 'succeeded' && ['create_github_issue', 'create_documentation_pull_request'].includes(step.toolName) && run.verifications.some(item => item.status !== 'passed' && item.label === (step.toolName === 'create_github_issue' ? 'GitHub issue exists' : 'Documentation pull request exists')))) {
      run.continuationCount += 1
      if (run.continuationCount > 3) throw new AppError(429, 'RETRY_LIMIT', 'This run has reached the retry limit.')
      return this.execution.retryWriteVerifications(run)
    }
    if (run.state !== 'awaiting_input' && run.state !== 'failed' && run.state !== 'partially_completed') throw new AppError(409, 'RUN_NOT_CONTINUABLE', 'Only runs awaiting clarification or with failed steps can be continued.')
    if (run.state === 'awaiting_input') {
      if (!repoInput) throw new AppError(400, 'REPOSITORY_REQUIRED', 'Provide a repository owner and name to continue this run.')
      run.repository = RepoSchema.parse(repoInput)
      run.clarificationQuestion = undefined
      run.state = transition(run.state, 'queued')
      run.plan = undefined
      run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'clarification_answered', message: `Repository context supplied: ${run.repository.owner}/${run.repository.name}.` })
      await this.store.save(run)
      const planned = await this.planning.plan(run)
      if (planned.state === 'failed') return planned
      return this.execution.execute(planned)
    }
    if (!run.plan) throw new AppError(409, 'NO_FAILED_STEPS', 'This run has no plan to continue.')
    const retryableWriteVerification = run.plan.steps.some(step => step.status === 'succeeded' && ['create_github_issue', 'create_documentation_pull_request'].includes(step.toolName) && run.verifications.some(item => item.status !== 'passed' && item.label === (step.toolName === 'create_github_issue' ? 'GitHub issue exists' : 'Documentation pull request exists')))
    if (!run.plan.steps.some(step => step.status === 'failed') && retryableWriteVerification) {
      run.continuationCount += 1
      if (run.continuationCount > 3) throw new AppError(429, 'RETRY_LIMIT', 'This run has reached the retry limit.')
      return this.execution.retryWriteVerifications(run)
    }
    if (!run.plan.steps.some(step => step.status === 'failed')) throw new AppError(409, 'NO_FAILED_STEPS', 'This run has no failed steps or retryable write verifications.')
    run.continuationCount += 1
    if (run.continuationCount > 3) throw new AppError(429, 'RETRY_LIMIT', 'This run has reached the retry limit.')
    for (const step of run.plan?.steps ?? []) if (step.status === 'failed') {
      step.status = 'pending'
      run.decisions = run.decisions.filter(decision => decision.actionId !== step.id)
      run.verifications = run.verifications.filter(item => item.label !== `Tool evidence: ${step.title}` && !(step.toolName === 'create_github_issue' && item.label === 'GitHub issue exists'))
    }
    run.state = transition(run.state, 'queued')
    run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'run_continued', message: `Retry ${run.continuationCount} requested. Previously successful actions are retained.` })
    await this.store.save(run)
    run.state = transition(run.state, 'executing')
    await this.store.save(run)
    return this.execution.execute(run)
  }
  async cancel(id: string) {
    const current = await this.get(id)
    if (['queued', 'planning', 'executing', 'verifying'].includes(current.state)) {
      this.execution.requestCancellation(id)
      return { ...current, cancellationRequested: true }
    }
    return this.exclusive(id, () => this.cancelLocked(id))
  }
  private async cancelLocked(id: string) {
    const run = await this.get(id)
    if (['executing', 'verifying'].includes(run.state)) throw new AppError(409, 'RUN_BUSY', 'This run cannot be cancelled while a tool call is in flight.')
    if (!['queued', 'planning', 'awaiting_input', 'awaiting_approval'].includes(run.state)) throw new AppError(409, 'RUN_NOT_CANCELLABLE', 'This run is already in a terminal state.')
    run.state = transition(run.state, 'cancelled')
    run.cancellationRequested = true
    run.updatedAt = new Date().toISOString()
    run.events.push({ id: newId('event'), at: run.updatedAt, type: 'run_cancelled', message: 'Run cancelled before the next external action.' })
    await this.store.save(run)
    return run
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.locks.set(id, current)
    await previous
    try { return await action() }
    finally { release(); if (this.locks.get(id) === current) this.locks.delete(id) }
  }
}
