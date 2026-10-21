import type { AgentRun, Verification } from '../domain.js'
import { newId } from '../domain.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { AppConfig } from '../config.js'
import { safeError } from '../errors.js'

export class VerificationService {
  constructor(private readonly tools: ToolRegistry, private readonly config: AppConfig) {}
  async verifyIssue(run: AgentRun, number: number) {
    const created = run.plan?.steps.find(step => step.toolName === 'create_github_issue')?.result as { title?: string; marker?: string } | undefined
    const evidence = await this.tools.execute('verify_github_issue', { ...run.repository!, number, expectedTitle: created?.title ?? '', marker: created?.marker ?? '' }, { config: this.config, repository: run.repository, runId: run.id }) as { verified: boolean; title?: string; url?: string; evidence?: string }
    const simulated = run.githubMode === 'mock'
    const item: Verification = { id: newId('verify'), label: 'GitHub issue exists', status: simulated ? 'inconclusive' : evidence.verified ? 'passed' : 'failed', detail: simulated ? 'Simulated verification only; no GitHub issue was read.' : evidence.verified ? `Issue #${number} was read back successfully.` : 'The issue could not be verified.', evidence: safeEvidence(evidence), verifiedAt: new Date().toISOString() }
    run.verifications.push(item)
    run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'verification_completed', message: item.detail, data: item })
    return item
  }
  async verifyPullRequest(run: AgentRun, number: number, branch: string) {
    const proposal = run.plan?.steps.find(step => step.toolName === 'prepare_readme_change')?.result as { path?: string; proposedContent?: string } | undefined
    const evidence = await this.tools.execute('verify_documentation_pull_request', { ...run.repository!, number, branch, path: proposal?.path ?? 'README.md', expectedContent: proposal?.proposedContent ?? '' }, { config: this.config, repository: run.repository, runId: run.id }) as { verified: boolean; title?: string; url?: string; branch?: string; mode?: string; contentMatches?: boolean }
    const simulated = run.githubMode === 'mock' || evidence.mode === 'mock'
    const item: Verification = { id: newId('verify'), label: 'Documentation pull request exists', status: simulated ? 'inconclusive' : evidence.verified ? 'passed' : 'failed', detail: simulated ? 'Simulated verification only; no GitHub pull request was read.' : evidence.verified ? `Pull request #${number} and the exact ${proposal?.path ?? 'README.md'} content were read back successfully from branch ${branch}.` : 'The pull request, branch, or file content did not match the approved result.', evidence: safeEvidence(evidence), verifiedAt: new Date().toISOString() }
    run.verifications.push(item)
    run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'verification_completed', message: item.detail, data: item })
    return item
  }
  async retryWriteVerifications(run: AgentRun) {
    for (const step of run.plan?.steps ?? []) {
      if (step.status !== 'succeeded') continue
      if (step.toolName === 'create_github_issue') {
        const created = step.result as { number?: number } | undefined
        if (!created?.number) continue
        run.verifications = run.verifications.filter(item => item.label !== 'GitHub issue exists')
        try { await this.verifyIssue(run, created.number) }
        catch (error) {
          const safe = safeError(error)
          this.addInconclusive(run, 'GitHub issue exists', `Issue creation returned successfully, but read-back verification was unavailable: ${safe.message}`)
        }
      }
      if (step.toolName === 'create_documentation_pull_request') {
        const created = step.result as { number?: number; branch?: string } | undefined
        if (!created?.number || !created.branch) continue
        run.verifications = run.verifications.filter(item => item.label !== 'Documentation pull request exists')
        try { await this.verifyPullRequest(run, created.number, created.branch) }
        catch (error) {
          const safe = safeError(error)
          this.addInconclusive(run, 'Documentation pull request exists', `Pull request creation returned successfully, but read-back verification was unavailable: ${safe.message}`)
        }
      }
    }
  }
  verifyPlanResults(run: AgentRun) {
    for (const step of run.plan?.steps ?? []) {
      if (step.toolName === 'create_github_issue') {
        if (step.status === 'awaiting_approval' && !run.verifications.some(item => item.label === `Approval: ${step.title}`)) {
          this.addPending(run, `Approval: ${step.title}`, 'A consequential action is paused until you approve or reject it.')
        }
        if (step.status === 'failed' && !run.verifications.some(item => item.label === 'GitHub issue exists')) {
          const item: Verification = { id: newId('verify'), label: 'GitHub issue exists', status: 'failed', detail: step.error ?? 'The issue tool did not return a verifiable issue.', verifiedAt: new Date().toISOString() }
          run.verifications.push(item)
        }
        continue
      }
      if (step.toolName === 'create_documentation_pull_request') {
        if (step.status === 'awaiting_approval' && !run.verifications.some(item => item.label === `Approval: ${step.title}`)) this.addPending(run, `Approval: ${step.title}`, 'A documentation commit and pull request are paused until you approve the exact target and proposed change.')
        if (step.status === 'failed' && !run.verifications.some(item => item.label === 'Documentation pull request exists')) run.verifications.push({ id: newId('verify'), label: 'Documentation pull request exists', status: 'failed', detail: step.error ?? 'The pull request could not be fetched for verification.', verifiedAt: new Date().toISOString() })
        continue
      }
      if (run.verifications.some(item => item.label === `Tool evidence: ${step.title}`)) continue
      let status: Verification['status']
      let detail: string
      if (step.status === 'failed') { status = 'failed'; detail = step.error ?? 'The tool action failed.' }
      else if (step.status === 'rejected') { status = 'inconclusive'; detail = 'The proposed action was declined.' }
      else if (step.status !== 'succeeded' || step.result === undefined) { status = 'inconclusive'; detail = 'No successful tool result is available yet.' }
      else if (step.toolName === 'prepare_readme_change') {
        const proposal = step.result as { prepared?: boolean; proposedContent?: string; writePerformed?: boolean }
        status = proposal.prepared && Boolean(proposal.proposedContent) && proposal.writePerformed === false ? 'passed' : 'failed'
        detail = status === 'passed' ? 'A review proposal was prepared; no file write was performed.' : 'The README proposal was incomplete.'
      } else if (run.githubMode === 'mock' || (step.result as { mode?: string } | undefined)?.mode === 'mock') {
        status = 'inconclusive'; detail = 'Tool output is a deterministic fixture and was not checked against GitHub.'
      } else {
        status = 'passed'; detail = 'The integration returned a structured repository result.'
      }
      const item: Verification = { id: newId('verify'), label: `Tool evidence: ${step.title}`, status, detail, evidence: step.status === 'succeeded' ? safeEvidence(step.result) : undefined, verifiedAt: new Date().toISOString() }
      run.verifications.push(item)
      run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'verification_completed', message: item.detail, stepId: step.id, data: { label: item.label, status: item.status } })
    }
    const failed = run.plan?.steps.some(step => step.status === 'failed' || step.status === 'rejected') ?? false
    const allPassed = run.verifications.length > 0 && run.verifications.every(item => item.status === 'passed')
    run.goalStatus = failed ? 'partially_achieved' : allPassed ? 'achieved' : 'unverified'
    return run.goalStatus
  }
  addPending(run: AgentRun, label: string, detail: string) { const item: Verification = { id: newId('verify'), label, status: 'inconclusive', detail, verifiedAt: new Date().toISOString() }; run.verifications.push(item); return item }
  addInconclusive(run: AgentRun, label: string, detail: string) {
    const item: Verification = { id: newId('verify'), label, status: 'inconclusive', detail, verifiedAt: new Date().toISOString() }
    run.verifications.push(item)
    run.events.push({ id: newId('event'), at: item.verifiedAt, type: 'verification_completed', message: detail, data: { label, status: item.status } })
    return item
  }
}

function safeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeEvidence)
  if (!value || typeof value !== 'object') return value
  const blocked = /^(?:content|body|expectedContent|token|access_token|refresh_token|authorization)$/i
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !blocked.test(key)).map(([key, item]) => [key, safeEvidence(item)]))
}
