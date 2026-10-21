import type { ActivityEntry, AgentRun, RunStatus, ToolCall, VerificationResult } from './types'

export type ApiPlanStep = { id: string; title: string; description: string; toolName: string; risk: string; permission: string; additionalPermissions?: string[]; requiresApproval: boolean; status: string; approvalDigest?: string; approvalPreview?: unknown; result?: unknown; error?: string }
export type ApiRun = { id: string; goal: string; repository?: { owner: string; name: string }; state: string; mode: 'mock' | 'openai'; githubMode: 'mock' | 'live'; goalStatus?: 'achieved' | 'partially_achieved' | 'unverified'; createdAt: string; updatedAt: string; plan?: { title: string; summary: string; clarificationQuestion: string | null; steps: ApiPlanStep[] }; events: { id: string; at: string; type: string; message: string; data?: unknown }[]; verifications: { id: string; label: string; status: 'passed' | 'failed' | 'inconclusive'; detail: string; verifiedAt: string; evidence?: unknown }[]; result?: string; clarificationQuestion?: string }
export type IntegrationStatus = { id: string; name: string; mode: 'mock' | 'live' | 'openai'; status: 'mock' | 'configured' | 'connected' | 'disconnected' | 'error'; repositories?: string[]; configured?: boolean; connected?: boolean; user?: { login: string; avatarUrl?: string } | null; permissions?: string[]; error?: string }
export type RepositoryRecord = { id: number; owner: string; name: string; fullName: string; description: string | null; defaultBranch: string; private: boolean; language: string | null; stars: number; openIssues: number; updatedAt: string; url: string; canWriteContents: boolean; canWriteIssues: boolean; canWritePullRequests: boolean }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('The LaunchPilot API request was cancelled.')
    throw new Error('LaunchPilot API is unavailable. Start the API server and try again.')
  }

  const isJson = response.headers.get('content-type')?.toLowerCase().includes('application/json') ?? false
  let body: { data?: T; error?: { message?: string } } | undefined
  if (isJson) {
    try { body = await response.json() as { data?: T; error?: { message?: string } } }
    catch {
      if (response.ok) throw new Error('The LaunchPilot API returned invalid JSON. Check the server logs and retry.')
    }
  }
  if (!response.ok) throw new Error(body?.error?.message ?? `LaunchPilot API request failed (${response.status}). Check that the API server is healthy and retry.`)
  if (!isJson || !body || !('data' in body)) throw new Error('The LaunchPilot API returned an unexpected response. Check the server and proxy configuration.')
  return body.data as T
}

export const api = {
  createRun: (goal: string, repository?: { owner: string; name: string }, readOnly = false, idempotencyKey = crypto.randomUUID()) => request<ApiRun>('/runs', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ goal, repository, readOnly }) }),
  listRuns: () => request<ApiRun[]>('/runs'),
  integrations: () => request<IntegrationStatus[]>('/integrations'),
  githubRepositories: () => request<RepositoryRecord[]>('/integrations/github/repositories'),
  disconnectGitHub: () => request<unknown>('/integrations/github/disconnect', { method: 'POST' }),
  decide: (id: string, actionId: string, digest: string, decision: 'approve' | 'reject') => request<ApiRun>(`/runs/${encodeURIComponent(id)}/approval`, { method: 'POST', body: JSON.stringify({ actionId, digest, decision }) }),
  continueRun: (id: string, repository?: { owner: string; name: string }) => request<ApiRun>(`/runs/${encodeURIComponent(id)}/continue`, { method: 'POST', body: JSON.stringify(repository ? { repository } : {}) }),
  cancelRun: (id: string) => request<ApiRun>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  getRun: (id: string) => request<ApiRun>(`/runs/${encodeURIComponent(id)}`),
}

export function toProject(repository: RepositoryRecord) {
  return { id: String(repository.id), owner: repository.owner, name: repository.name, description: repository.description ?? 'No repository description provided.', language: repository.language ?? 'Not specified', updated: new Date(repository.updatedAt).toLocaleDateString(), status: 'Connected' as const, initials: repository.name.slice(0, 1).toUpperCase(), color: 'violet', stars: repository.stars, openIssues: repository.openIssues, url: repository.url, defaultBranch: repository.defaultBranch, private: repository.private, canWriteContents: repository.canWriteContents, canWriteIssues: repository.canWriteIssues, canWritePullRequests: repository.canWritePullRequests }
}

function uiStatus(state: string, githubMode: 'mock' | 'live', goalStatus?: ApiRun['goalStatus']): RunStatus {
  if (state === 'cancelled') return 'Cancelled'
  if (state === 'partially_completed') return 'Partially completed'
  if (state === 'failed') return 'Failed'
  if (githubMode === 'mock' && state === 'completed') return 'Simulated'
  if (state === 'awaiting_approval') return 'Awaiting approval'
  if (state === 'queued' || state === 'executing' || state === 'planning' || state === 'verifying') return 'Running'
  if (state === 'completed' && goalStatus === 'achieved') return 'Verified'
  if (state === 'completed') return 'Inconclusive'
  return 'Planned'
}

function resultText(result: unknown): string {
  if (!result) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object' && result !== null) {
    const value = result as Record<string, unknown>
    const simulated = value.mode === 'mock' ? 'SIMULATED FIXTURE · ' : ''
    if (typeof value.content === 'string') return `${simulated}${value.content.slice(0, 800)}`
    if (Array.isArray(value.issues)) return `${simulated}${value.issues.length} issue(s) returned.`
    if (typeof value.fullName === 'string') return `${simulated}Repository metadata returned for ${value.fullName}.`
    if (value.prepared === true) return `Review-only README proposal (no file changed):\n${String(value.proposedContent ?? '').slice(0, 1400)}`
    if (typeof value.url === 'string') return `${simulated}${value.created ? 'Issue action returned' : 'Resource returned'}: ${value.url}`
    if (Array.isArray(value.checks)) return `${simulated}${value.checks.map((check: { name: string; present: boolean }) => `${check.present ? '✓' : '○'} ${check.name}`).join(' · ')}`
    return `${simulated}${JSON.stringify(value).slice(0, 800)}`
  }
  return String(result)
}

export function toAgentRun(run: ApiRun): AgentRun {
  const tools: ToolCall[] = (run.plan?.steps ?? []).map(step => ({
    id: step.id, tool: step.toolName.replace(/_/g, ' '), action: step.description, resultUrl: safeResultUrl(step.result),
    resultLinks: resultLinks(step.result),
    status: step.status === 'succeeded' ? 'Complete' : step.status === 'failed' ? 'Failed' : step.status === 'running' ? 'Running' : 'Pending',
    result: step.error ?? resultText(step.result), duration: '—',
  }))
  const verification: VerificationResult[] = run.verifications.map(item => ({ id: item.id, label: item.label, status: item.status, detail: item.detail, verifiedAt: item.verifiedAt, evidence: item.evidence }))
  return {
    id: run.id, backendRunId: run.id, title: run.plan?.title ?? run.clarificationQuestion ?? run.goal.slice(0, 90), project: run.repository?.name ?? 'Needs repository', owner: run.repository?.owner, stage: run.state,
    status: uiStatus(run.state, run.githubMode, run.goalStatus), time: new Date(run.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    summary: run.result ?? run.plan?.summary ?? run.clarificationQuestion ?? 'Planning is in progress.', tools, verification,
    mode: run.mode, githubMode: run.githubMode, goalStatus: run.goalStatus, planSteps: run.plan?.steps.map(({ id, title, description, status, risk, permission, additionalPermissions, requiresApproval, toolName, approvalDigest, approvalPreview, result }) => ({ id, title, description, status, risk, permission, additionalPermissions, requiresApproval, toolName, approvalDigest, approvalPreview, result })),
  }
}

function resultLinks(result: unknown): { label: string; url: string }[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const value = result as Record<string, unknown>
  const rows = Array.isArray(value.issues) ? value.issues : Array.isArray(value.pullRequests) ? value.pullRequests : []
  const links = rows.flatMap(row => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    if (typeof item.url !== 'string') return []
    const url = parseGitHubResourceUrl(item.url)
    if (!url) return []
    return [{ label: `#${String(item.number ?? '')} ${String(item.title ?? 'GitHub result')}`.slice(0, 100), url }]
  })
  return links.length ? links.slice(0, 5) : undefined
}

function safeResultUrl(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('url' in result) || typeof (result as { url?: unknown }).url !== 'string') return undefined
  return parseGitHubResourceUrl((result as { url: string }).url)
}

function parseGitHubResourceUrl(value: string) {
  try {
    const url = new URL(value)
    return url.origin === 'https://github.com' && /^\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+$/.test(url.pathname) ? url.toString() : undefined
  } catch { return undefined }
}

export function toActivityEntries(runs: ApiRun[]): ActivityEntry[] {
  return runs.flatMap(run => run.events.map(event => {
    const verificationStatus = event.data && typeof event.data === 'object' && 'status' in event.data ? (event.data as { status?: string }).status : undefined
    const outcome: RunStatus = event.type === 'approval_granted' ? 'Approved' : event.type === 'approval_rejected' ? 'Rejected' : event.type === 'verification_completed' ? verificationStatus === 'passed' ? 'Verified' : verificationStatus === 'failed' ? 'Verification failed' : run.githubMode === 'mock' ? 'Simulated' : 'Inconclusive' : event.type.includes('failed') ? 'Failed' : event.type.includes('approval_requested') ? 'Awaiting approval' : event.type.includes('run_finished') && run.githubMode === 'mock' ? 'Simulated' : event.type.includes('run_finished') ? uiStatus(run.state, run.githubMode, run.goalStatus) : event.type.includes('tool_succeeded') ? run.githubMode === 'mock' ? 'Simulated' : 'Running' : event.type.includes('started') ? 'Running' : 'Planned'
    return { id: `${run.id}-${event.id}`, kind: event.type.replace(/_/g, ' '), title: event.message, project: run.repository?.name ?? 'Unassigned', time: new Date(event.at).toLocaleString(), outcome, evidence: event.data, detail: `Run ${run.id} · LLM ${run.mode} · GitHub ${run.githubMode}. ${event.message}`, source: 'backend' as const }
  })).sort((a, b) => {
    const left = Date.parse(a.time), right = Date.parse(b.time)
    if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0
    if (!Number.isFinite(right)) return -1
    return right - left
  })
}
