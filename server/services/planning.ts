import type { AppConfig } from '../config.js'
import { transition } from '../stateMachine.js'
import { newId, type AgentRun, type ExecutionPlan, type PlanStep, type Repository, type ToolName } from '../domain.js'
import { redactUntrusted } from '../security.js'
import { ToolRegistry } from '../tools/registry.js'
import type { RunStore } from '../store.js'
import type { LlmProvider } from '../provider/llm.js'

export class PlanningService {
  constructor(private readonly store: RunStore, private readonly tools: ToolRegistry, private readonly provider: LlmProvider, private readonly config: AppConfig) {}
  async plan(run: AgentRun): Promise<AgentRun> {
    if (!run.repository) {
      run.clarificationQuestion = 'Which GitHub repository should I work with? Please provide its owner and repository name.'
      run.state = transition(run.state, 'awaiting_input')
      this.event(run, 'clarification_requested', run.clarificationQuestion)
      await this.store.save(run)
      return run
    }
    run.state = transition(run.state, 'planning')
    this.event(run, 'planning_started', `Preparing a structured plan in ${run.mode} mode.`)
    await this.store.save(run)
    try {
      run.plan = await this.provider.plan(redactUntrusted(run.goal), run.repository, run.id)
      // Enforce tool permissions server-side regardless of the model's classifications.
      run.plan.steps = run.plan.steps.map(step => this.constrain(step, run.readOnly === true))
      if (run.readOnly) for (const step of run.plan.steps.filter(candidate => candidate.status === 'skipped' && (candidate.toolName === 'create_github_issue' || candidate.toolName === 'create_documentation_pull_request'))) {
        this.event(run, 'action_skipped_read_only', `Skipped ${step.toolName}; read-only mode is enabled.`)
      }
      this.event(run, 'plan_created', `${run.plan.steps.length} ordered steps are ready for execution.`)
      await this.store.save(run)
      return run
    } catch {
      run.state = transition(run.state, 'failed')
      run.result = 'Planning failed. Check the configured model provider and try again.'
      this.event(run, 'planning_failed', run.result)
      await this.store.save(run)
      return run
    }
  }
  private constrain(step: PlanStep, readOnly: boolean): PlanStep {
    const externalWrite = step.toolName === 'create_github_issue' || step.toolName === 'create_documentation_pull_request'
    if (readOnly && externalWrite) return { ...step, risk: 'high', permission: step.toolName === 'create_github_issue' ? 'issue:write' : 'contents:write', additionalPermissions: step.toolName === 'create_documentation_pull_request' ? ['pull_request:write'] : [], requiresApproval: false, status: 'skipped', description: `${step.description} Not proposed because read-only mode is enabled.` }
    if (step.toolName === 'create_documentation_pull_request' && this.config.GITHUB_MODE === 'live' && this.config.GITHUB_APP_CONTENTS_WRITE !== 'true') {
      return { ...step, risk: 'high', permission: 'contents:write', additionalPermissions: ['pull_request:write'], requiresApproval: false, status: 'skipped', description: `${step.description} Disabled: enable the optional Contents and Pull requests write permissions to use this action.` }
    }
    const action = step.toolName === 'create_github_issue' || step.toolName === 'create_documentation_pull_request'
    const metadata = this.tools.permissions(step.toolName as ToolName)
    if (!metadata) throw new Error('Unknown tool in plan')
    if (metadata.risk === 'high_impact') return { ...step, risk: metadata.risk, permission: metadata.permission, requiresApproval: false, status: 'skipped', description: `${step.description} Disabled by the high-impact action safety policy.` }
    return { ...step, risk: metadata.risk, permission: metadata.permission, additionalPermissions: metadata.additionalPermissions.filter(permission => permission !== 'none'), requiresApproval: metadata.requiresApproval, status: 'pending', ...(action ? { status: 'awaiting_approval' as const } : {}) }
  }
  private event(run: AgentRun, type: string, message: string) { run.events.push({ id: newId('event'), at: new Date().toISOString(), type, message }) }
}

export function toolInput(step: PlanStep, run: AgentRun): unknown {
  const repository = run.repository!
  switch (step.toolName) {
    case 'inspect_repository': case 'list_repository_issues': case 'list_repository_pull_requests': case 'inspect_repository_structure': return repository
    case 'read_repository_file': return { ...repository, path: 'README.md' }
    case 'prepare_readme_change': {
      const readme = run.plan?.steps.find(candidate => candidate.toolName === 'read_repository_file')?.result as { content?: string } | undefined
      const readmePath = (readme as { path?: string } | undefined)?.path
      const current = readme?.content ?? '# Project\n\nProject overview and setup instructions.\n'
      const structure = run.plan?.steps.find(candidate => candidate.toolName === 'inspect_repository_structure')?.result as { checks?: { name: string; present: boolean }[] } | undefined
      const gaps = (structure?.checks ?? []).filter(check => !check.present).map(check => check.name.toLowerCase())
      const additions: string[] = []
      if (gaps.includes('setup') && !/^##+\s+(setup|installation|getting started|local development)/im.test(current)) additions.push('## Local setup\n\nDocument the required runtime version, installation steps, and the command to run the project locally.')
      if (gaps.includes('demo') && !/^##+\s+(demo|preview)/im.test(current)) additions.push('## Demo\n\nAdd a link to the deployed project or a short demo video, plus any instructions needed to try it.')
      if (gaps.includes('contributing') && !/^##+\s+(contributing|development)/im.test(current)) additions.push('## Contributing\n\nExplain how to report an issue, run checks, and submit a proposed change.')
      if (gaps.includes('license') && !/^##+\s+license/im.test(current)) additions.push('## License\n\nLink the license used by this project. Add the corresponding license file at the repository root before publishing.')
      if (!additions.length) additions.push('## Project overview\n\nAdd a concise description of the problem this project solves, its primary features, and the intended audience.')
      return { path: ['README.md', 'README.rst', 'README'].includes(readmePath ?? '') ? readmePath : 'README.md', proposedContent: `${current.trim()}\n\n${additions.join('\n\n')}\n` }
    }
    case 'create_github_issue': return { ...repository, title: `Follow up: ${run.goal.slice(0, 150)}`, body: `Created by an explicitly approved LaunchPilot action for run ${run.id}.\n\nGoal: ${run.goal}` }
    case 'create_documentation_pull_request': {
      const proposal = run.plan?.steps.find(candidate => candidate.toolName === 'prepare_readme_change')?.result as { path?: string; proposedContent?: string } | undefined
      if (!proposal?.proposedContent) throw new Error('There is no reviewed README proposal to commit.')
      return { ...repository, path: proposal.path ?? 'README.md', content: proposal.proposedContent, title: 'Improve README for submission', body: `Proposed by LaunchPilot for run ${run.id}. Please review the README changes before merging.` }
    }
    case 'verify_github_issue': {
      const created = run.plan?.steps.find(candidate => candidate.toolName === 'create_github_issue')?.result as { number?: number; title?: string; marker?: string } | undefined
      if (!created?.number || !created.title || !created.marker) throw new Error('The issue action did not return enough evidence to verify its result.')
      return { ...repository, number: created.number, expectedTitle: created.title, marker: created.marker }
    }
    case 'verify_documentation_pull_request': {
      const created = run.plan?.steps.find(candidate => candidate.toolName === 'create_documentation_pull_request')?.result as { number?: number; branch?: string } | undefined
      const proposal = run.plan?.steps.find(candidate => candidate.toolName === 'prepare_readme_change')?.result as { path?: string; proposedContent?: string } | undefined
      if (!created?.number || !created.branch || !proposal?.proposedContent) throw new Error('There is no pull request available to verify.')
      return { ...repository, number: created.number, branch: created.branch, path: proposal.path ?? 'README.md', expectedContent: proposal.proposedContent }
    }
    case 'verify_repository_file': {
      const proposal = run.plan?.steps.find(candidate => candidate.toolName === 'prepare_readme_change')?.result as { path?: string; proposedContent?: string } | undefined
      if (!proposal?.proposedContent) throw new Error('There is no proposed README content to verify.')
      return { ...repository, path: proposal.path ?? 'README.md', expectedContent: proposal.proposedContent }
    }
    default: throw new Error(`Tool ${step.toolName} is not available in the normal execution path.`)
  }
}
