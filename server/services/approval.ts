import type { AgentRun } from '../domain.js'
import { newId } from '../domain.js'
import type { RunStore } from '../store.js'
import { AppError } from '../errors.js'
import { ExecutionService } from './execution.js'
import { transition } from '../stateMachine.js'

export class ApprovalService {
  constructor(private readonly store: RunStore, private readonly execution: ExecutionService) {}
  async decide(run: AgentRun, actionId: string, digest: string, decision: 'approve' | 'reject') {
    if (run.state !== 'awaiting_approval') throw new AppError(409, 'RUN_NOT_AWAITING_APPROVAL', 'This run is not waiting for approval.')
    const step = run.plan?.steps.find(candidate => candidate.id === actionId && candidate.requiresApproval)
    if (!step || step.status !== 'awaiting_approval') throw new AppError(404, 'ACTION_NOT_PENDING', 'That action is not awaiting approval.')
    if (run.decisions.some(item => item.actionId === actionId)) throw new AppError(409, 'DECISION_ALREADY_RECORDED', 'A decision has already been recorded for this action.')
    const currentDigest = this.execution.digest(step, run)
    if (!step.approvalDigest || digest !== step.approvalDigest || currentDigest !== step.approvalDigest) {
      step.approvalDigest = currentDigest
      step.approvalPreview = this.execution.preview(step, run)
      run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'approval_invalidated', message: `The proposed action “${step.title}” changed. A new review is required.`, data: { actionId, digest: currentDigest } })
      await this.store.save(run)
      throw new AppError(409, 'APPROVAL_STALE', 'The proposed action changed. Review the updated target and content before deciding again.')
    }
    run.decisions.push({ actionId, digest: currentDigest, decision, decidedAt: new Date().toISOString(), decidedBy: 'user' })
    if (decision === 'reject') {
      step.status = 'rejected'
      run.state = transition(run.state, 'partially_completed')
      run.goalStatus = 'partially_achieved'
      const approvalEvidence = run.verifications.find(item => item.label === `Approval: ${step.title}`)
      if (approvalEvidence) approvalEvidence.detail = 'The user declined this external action; it was not executed.'
      run.result = 'The proposed consequential action was declined. No write was performed.'
      run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'approval_rejected', message: `The action “${step.title}” was declined.`, data: { actionId, digest: currentDigest, decision } })
      await this.store.save(run)
      return run
    }
    run.verifications = run.verifications.filter(item => item.label !== `Approval: ${step.title}`)
    run.events.push({ id: newId('event'), at: new Date().toISOString(), type: 'approval_granted', message: `The action “${step.title}” was approved.`, data: { actionId, digest: currentDigest, decision } })
    run.state = transition(run.state, 'executing')
    await this.store.save(run)
    return this.execution.execute(run, actionId)
  }
}
