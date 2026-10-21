import type { AppConfig } from '../config.js'
import type { AgentRun, PlanStep } from '../domain.js'
import { newId } from '../domain.js'
import { safeError } from '../errors.js'
import type { RunStore } from '../store.js'
import { transition } from '../stateMachine.js'
import { ToolRegistry } from '../tools/registry.js'
import { toolInput } from './planning.js'
import { VerificationService } from './verification.js'
import { createHash } from 'node:crypto'

export function actionDigest(step: PlanStep, run: AgentRun, tools: ToolRegistry): string {
  const permissions = tools.permissions(step.toolName)
  const canonical = JSON.stringify({ toolName: step.toolName, target: run.repository, input: toolInput(step, run), permissions })
  return createHash('sha256').update(canonical).digest('hex')
}

export class ExecutionService {
  private readonly cancellationRequests = new Set<string>()
  constructor(private readonly store: RunStore, private readonly tools: ToolRegistry, private readonly verification: VerificationService, private readonly config: AppConfig) {}
  requestCancellation(runId: string) { this.cancellationRequests.add(runId) }
  clearCancellationRequest(runId: string) { this.cancellationRequests.delete(runId) }
  digest(step: PlanStep, run: AgentRun) { return actionDigest(step, run, this.tools) }
  preview(step: PlanStep, run: AgentRun) { return toolInput(step, run) }
  async retryWriteVerifications(run: AgentRun): Promise<AgentRun> {
    if (run.state !== 'completed' && run.state !== 'partially_completed') throw new Error('Only a completed run can retry write verification.')
    run.state = transition(run.state, 'verifying')
    run.updatedAt = new Date().toISOString()
    run.events.push({ id: newId('event'), at: run.updatedAt, type: 'verification_retry_started', message: 'Rechecking previously created GitHub resources. No write action will be repeated.' })
    await this.store.save(run)
    await this.verification.retryWriteVerifications(run)
    const goalStatus = this.verification.verifyPlanResults(run)
    const failedVerification = run.verifications.some(item => item.status === 'failed' && ['GitHub issue exists', 'Documentation pull request exists'].includes(item.label))
    run.state = transition(run.state, failedVerification ? 'partially_completed' : 'completed')
    run.goalStatus = goalStatus
    run.result = failedVerification ? 'The GitHub resource was fetched again, but its contents did not match the approved action.' : goalStatus === 'achieved' ? 'The GitHub resource was fetched again and the verification checks passed.' : 'The GitHub resource was rechecked, but the run remains unverified in the configured integration mode.'
    run.updatedAt = new Date().toISOString()
    run.events.push({ id: newId('event'), at: run.updatedAt, type: 'verification_retry_finished', message: run.result })
    await this.store.save(run)
    return run
  }
  async execute(run: AgentRun, approvedActionId?: string): Promise<AgentRun> {
    if (!run.plan || !run.repository) throw new Error('A planned run and repository are required before execution.')
    if (run.state !== 'executing') run.state = transition(run.state, 'executing')
    run.executionLock = newId('exec')
    run.updatedAt = new Date().toISOString()
    run.events.push({ id: newId('event'), at: run.updatedAt, type: 'execution_started', message: 'Executing permitted plan steps.' })
    await this.store.save(run)
    let failed = false
    try {
      for (const step of run.plan.steps) {
        if (run.cancellationRequested || this.cancellationRequests.has(run.id)) {
          run.cancellationRequested = true
          run.state = transition(run.state, 'cancelled')
          run.result = 'Run cancelled before the next tool action. Any completed actions remain recorded.'
          this.event(run, 'run_cancelled', run.result)
          break
        }
        if (step.status === 'succeeded' || step.status === 'rejected' || step.status === 'failed' || step.status === 'skipped') { if (step.status === 'failed' || step.status === 'rejected') failed = true; continue }
        if (run.readOnly && (step.toolName === 'create_github_issue' || step.toolName === 'create_documentation_pull_request')) {
          step.status = 'skipped'
          step.description = `${step.description} Not executed because read-only mode is enabled.`
          this.event(run, 'action_skipped_read_only', `Skipped ${step.toolName}; this run is read-only.`, step)
          await this.store.save(run)
          continue
        }
        if (step.requiresApproval) {
          if (step.id !== approvedActionId) {
            step.approvalDigest = actionDigest(step, run, this.tools)
            step.approvalPreview = toolInput(step, run)
            if (!step.description.includes('Target:')) {
              const preview = toolInput(step, run) as { title?: string; path?: string; branch?: string }
              const target = step.toolName === 'create_github_issue'
                ? `${run.repository.owner}/${run.repository.name} · issue title “${preview.title ?? step.title}”`
                : `${run.repository.owner}/${run.repository.name} · ${preview.path ?? 'README'} · new run-specific branch and pull request`
              step.description = `${step.description} Target: ${target}.`
            }
            step.status = 'awaiting_approval'
            this.verification.verifyPlanResults(run)
            run.goalStatus = 'unverified'
            run.state = transition(run.state, 'awaiting_approval')
            this.event(run, 'approval_requested', `Approval is required for: ${step.title}`, step)
            await this.store.save(run)
            return run
          }
          const decision = run.decisions.find(item => item.actionId === step.id && item.decision === 'approve')
          if (!decision) throw new Error('No persisted approval exists for this action.')
          const digest = actionDigest(step, run, this.tools)
          if (!step.approvalDigest || decision.digest !== digest || step.approvalDigest !== digest) {
            step.status = 'awaiting_approval'
            step.approvalDigest = digest
            run.decisions = run.decisions.filter(item => item.actionId !== step.id)
            run.state = transition(run.state, 'awaiting_approval')
            this.event(run, 'approval_invalidated', 'The proposed action changed after approval. Review and approve the updated action.', step)
            await this.store.save(run)
            return run
          }
        }
        step.status = 'running'
        this.event(run, 'tool_started', `Starting ${step.toolName}.`, step, { toolName: step.toolName, risk: step.risk, permission: step.permission, additionalPermissions: step.additionalPermissions ?? [] })
        await this.store.save(run)
        try {
          step.result = await this.tools.execute(step.toolName, toolInput(step, run), { config: this.config, repository: run.repository, runId: run.id }, step.requiresApproval)
          step.status = 'succeeded'
          if (step.toolName === 'prepare_readme_change') this.minimizeReadme(run)
          this.event(run, 'tool_succeeded', `${step.toolName} returned a result.`, step, { toolName: step.toolName, result: auditResult(step.toolName, step.result) })
          if (step.toolName === 'create_github_issue') {
            const result = step.result as { number?: number }
            if (result.number) {
              try {
                const verification = await this.verification.verifyIssue(run, result.number)
                if (verification.status === 'failed') failed = true
              } catch (error) {
                const safe = safeError(error)
                this.verification.addInconclusive(run, 'GitHub issue exists', `Issue creation returned successfully, but read-back verification was unavailable: ${safe.message}`)
              }
            }
          }
          if (step.toolName === 'create_documentation_pull_request') {
            const result = step.result as { number?: number; branch?: string }
            if (result.number && result.branch) {
              try {
                const verification = await this.verification.verifyPullRequest(run, result.number, result.branch)
                if (verification.status === 'failed') failed = true
              } catch (error) {
                const safe = safeError(error)
                this.verification.addInconclusive(run, 'Documentation pull request exists', `Pull request creation returned successfully, but read-back verification was unavailable: ${safe.message}`)
              }
            }
          }
        } catch (error) {
          const safe = safeError(error)
          step.status = 'failed'
          step.error = safe.message
          failed = true
          this.event(run, 'tool_failed', `The ${step.toolName} action failed: ${safe.message}`, step, { toolName: step.toolName, code: safe.code, message: safe.message })
        }
        run.updatedAt = new Date().toISOString()
        await this.store.save(run)
      }
      this.minimizeReadme(run)
      if (run.state === 'cancelled') return run
      run.state = transition(run.state, 'verifying')
      this.event(run, 'verification_started', 'Checking the evidence returned by completed actions.')
      const goalStatus = this.verification.verifyPlanResults(run)
      const pending = run.plan.steps.filter(step => step.status === 'awaiting_approval')
      if (pending.length) { run.state = transition(run.state, 'awaiting_approval'); return run }
      run.state = transition(run.state, failed || run.plan.steps.some(step => step.status === 'failed' || step.status === 'rejected') ? 'partially_completed' : 'completed')
      run.result = goalStatus === 'achieved' ? 'The planned tool steps returned and every verification check passed.' : goalStatus === 'partially_achieved' ? 'Some steps failed or were declined; the original goal is only partially achieved.' : 'Tool execution ended, but the original goal remains unverified. Review pending checks and evidence.'
      this.event(run, 'run_finished', run.result)
      run.updatedAt = new Date().toISOString()
      return run
    } finally {
      this.cancellationRequests.delete(run.id)
      run.executionLock = undefined
      run.updatedAt = new Date().toISOString()
      await this.store.save(run)
    }
  }
  private event(run: AgentRun, type: string, message: string, step?: PlanStep, data?: unknown) { run.events.push({ id: newId('event'), at: new Date().toISOString(), type, message, stepId: step?.id, data }) }
  private minimizeReadme(run: AgentRun) {
    const readme = run.plan?.steps.find(step => step.toolName === 'read_repository_file')
    const value = readme?.result as { path?: string; exists?: boolean; content?: string; mode?: string } | undefined
    if (!readme || !value || typeof value.content !== 'string') return
    readme.result = { path: value.path, exists: value.exists, mode: value.mode, contentOmitted: true, contentLength: value.content.length, contentSha256: createHash('sha256').update(value.content).digest('hex') }
  }
}

function auditResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const value = result as Record<string, unknown>
  if (toolName === 'read_repository_file') return { path: value.path, exists: value.exists, contentLength: typeof value.content === 'string' ? value.content.length : 0 }
  if (toolName === 'prepare_readme_change') return { prepared: value.prepared, path: value.path, proposedCharacters: typeof value.proposedContent === 'string' ? value.proposedContent.length : 0, writePerformed: value.writePerformed }
  if (toolName === 'create_github_issue' || toolName === 'create_documentation_pull_request') return Object.fromEntries(Object.entries(value).filter(([key]) => !['body', 'content', 'marker'].includes(key)))
  if (toolName === 'list_repository_issues' && Array.isArray(value.issues)) return { count: value.issues.length, numbers: value.issues.map(item => (item as { number?: number }).number) }
  if (toolName === 'list_repository_pull_requests' && Array.isArray(value.pullRequests)) return { count: value.pullRequests.length, numbers: value.pullRequests.map(item => (item as { number?: number }).number) }
  if (toolName === 'inspect_repository') return { fullName: value.fullName, defaultBranch: value.defaultBranch, language: value.language, openIssuesCount: value.openIssuesCount }
  return value
}
