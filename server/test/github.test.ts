import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { GitHubConnectionService } from '../github/connection.js'
import type { AppConfig } from '../config.js'
import { MemoryRunStore } from '../store.js'
import { ToolRegistry } from '../tools/registry.js'
import { MockLlmProvider } from '../provider/llm.js'
import { PlanningService } from '../services/planning.js'
import { VerificationService } from '../services/verification.js'
import { ExecutionService } from '../services/execution.js'
import { ApprovalService } from '../services/approval.js'
import { AgentService } from '../services/agent.js'

const key = Buffer.alloc(32, 7).toString('base64')
async function setup(fetchImpl?: typeof fetch) {
  const directory = await mkdtemp(resolve(tmpdir(), 'launchpilot-gh-'))
  const config = { NODE_ENV: 'test', PORT: 3001, DATA_DIR: directory, LLM_MODE: 'mock', OPENAI_MODEL: 'gpt-5.5', GITHUB_MODE: 'live', GITHUB_APP_CLIENT_ID: 'Iv1.test', GITHUB_APP_CLIENT_SECRET: 'secret-value', GITHUB_APP_CALLBACK_URL: 'http://localhost:5173/api/integrations/github/callback', GITHUB_TOKEN_ENCRYPTION_KEY: key, GITHUB_APP_CONTENTS_WRITE: 'false', GITHUB_READINESS_REQUIREMENTS: 'readme,setup,license,demo', readinessRequirements: ['readme', 'setup', 'license', 'demo'], CORS_ORIGIN: 'http://localhost:5173', REQUEST_TIMEOUT_MS: 1500, RUN_RATE_LIMIT: 30 } as AppConfig
  const service = new GitHubConnectionService(config)
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl)
  return { service, directory, config }
}
const repoFixture = { id: 1, name: 'launchpilot', full_name: 'octo/launchpilot', description: 'Agent workspace', default_branch: 'main', private: true, language: 'TypeScript', stargazers_count: 12, open_issues_count: 2, updated_at: '2026-10-21T00:00:00Z', html_url: 'https://github.com/octo/launchpilot', permissions: { push: true } }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('GitHub App connection', () => {
  it('validates OAuth state before exchanging credentials', async () => {
    const fetchMock = vi.fn()
    const { service, directory } = await setup(fetchMock as typeof fetch)
    await expect(service.completeOAuth('code', 'a'.repeat(64), 'b'.repeat(64))).rejects.toMatchObject({ code: 'GITHUB_OAUTH_STATE_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
    await rm(directory, { recursive: true, force: true })
  })

  it('encrypts tokens, lists real-shaped repositories and revokes the grant on disconnect', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu-sensitive-access', refresh_token: 'ghr-sensitive-refresh', expires_in: 28800, refresh_token_expires_in: 15897600 }), { status: 200 })
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' }), { status: 200 })
      if (url.endsWith('/user/repos?per_page=100&page=1&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member')) return new Response(JSON.stringify([repoFixture]), { status: 200 })
      if (url.includes('/applications/Iv1.test/grant') && init?.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response('{}', { status: 404 })
    })
    const { service, directory } = await setup(fetchMock as typeof fetch)
    await service.completeOAuth('authorization-code', 'c'.repeat(64), 'c'.repeat(64))
    const encrypted = await readFile(resolve(directory, 'github-connection.enc'), 'utf8')
    expect(encrypted).not.toContain('ghu-sensitive-access')
    expect(encrypted).not.toContain('ghr-sensitive-refresh')
    expect((await service.status()).user?.login).toBe('octocat')
    const repositories = await service.listRepositories()
    expect(repositories[0]).toMatchObject({ fullName: 'octo/launchpilot', defaultBranch: 'main', private: true, language: 'TypeScript', canWriteContents: true })
    const listCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/user/repos'))
    expect(new Headers(listCall?.[1]?.headers).get('Authorization')).toBe('Bearer ghu-sensitive-access')
    await service.disconnect()
    expect((await service.status()).connected).toBe(false)
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/grant') && init?.method === 'DELETE')).toBe(true)
    await rm(directory, { recursive: true, force: true })
  })

  it('maps GitHub rate limits and missing permissions to actionable safe errors', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 })
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octocat', avatar_url: '' }), { status: 200 })
      if (url.endsWith('/rate')) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) } })
      return new Response('{}', { status: 403, headers: { 'x-accepted-github-permissions': 'issues=write' } })
    })
    const { service, directory } = await setup(fetchMock as typeof fetch)
    await service.completeOAuth('code', 'd'.repeat(64), 'd'.repeat(64))
    await expect(service.request('/rate')).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMIT', statusCode: 429 })
    await expect(service.request('/permission')).rejects.toMatchObject({ code: 'GITHUB_PERMISSION_MISSING', statusCode: 403 })
    await rm(directory, { recursive: true, force: true })
  })

  it('invalidates a saved connection after GitHub rejects its access token', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu-token-rejected', refresh_token: 'ghr-refresh', expires_in: 28800 }), { status: 200 })
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octocat', avatar_url: '' }), { status: 200 })
      return new Response('{}', { status: 401 })
    })
    const { service, directory } = await setup(fetchMock as typeof fetch)
    await service.completeOAuth('code', 'f'.repeat(64), 'f'.repeat(64))
    expect((await service.status()).connected).toBe(true)
    await expect(service.request('/private')).rejects.toMatchObject({ code: 'GITHUB_TOKEN_INVALID' })
    expect(await service.status()).toMatchObject({ connected: false, status: 'disconnected' })
    await rm(directory, { recursive: true, force: true })
  })

  it('maps unreadable authorization responses to safe provider errors', async () => {
    const { service, directory } = await setup(vi.fn(async () => new Response('<html>not JSON</html>', { status: 200 })) as typeof fetch)
    await expect(service.completeOAuth('code', 'a'.repeat(64), 'a'.repeat(64))).rejects.toMatchObject({ code: 'GITHUB_OAUTH_INVALID_RESPONSE' })
    await rm(directory, { recursive: true, force: true })
  })

  it('gates a live-shaped issue write, fetches it back, and reports verified evidence', async () => {
    let createdIssue: { number: number; title: string; body: string; html_url: string } | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu-live-shape', refresh_token: 'ghr-live-shape', expires_in: 28800, refresh_token_expires_in: 15897600 }), { status: 200 })
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octocat', avatar_url: '' }), { status: 200 })
      if (url.endsWith('/user/repos?per_page=100&page=1&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member')) return new Response(JSON.stringify([repoFixture]), { status: 200 })
      if (url.endsWith('/repos/octo/launchpilot')) return new Response(JSON.stringify({ ...repoFixture, full_name: 'octo/launchpilot' }), { status: 200 })
      if (url.endsWith('/languages')) return new Response(JSON.stringify({ TypeScript: 100 }), { status: 200 })
      if (url.endsWith('/readme')) return new Response(JSON.stringify({ type: 'file', size: 20, path: 'README.md', encoding: 'base64', content: Buffer.from('# A real project\n\n## Setup\nnpm install\n').toString('base64') }), { status: 200 })
      if (url.endsWith('/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1')) return new Response('[]', { status: 200 })
      if (url.endsWith('/issues?state=open&sort=updated&direction=desc&per_page=100&page=1')) return new Response('[]', { status: 200 })
      if (url.endsWith('/issues?state=all&sort=created&direction=desc&per_page=100&page=1')) return new Response(JSON.stringify(createdIssue ? [createdIssue] : []), { status: 200 })
      if (url.endsWith('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'base-commit' } }), { status: 200 })
      if (url.endsWith('/git/trees/base-commit?recursive=1')) return new Response(JSON.stringify({ tree: ['README.md', 'package.json', 'LICENSE', 'DEMO.md', 'CONTRIBUTING.md'].map(path => ({ path, type: 'blob' })) }), { status: 200 })
      if (url.endsWith('/issues') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { title: string; body: string }
        createdIssue = { number: 42, title: body.title, body: body.body, html_url: 'https://github.com/octo/launchpilot/issues/42' }
        return new Response(JSON.stringify(createdIssue), { status: 201 })
      }
      if (url.endsWith('/issues/42') && createdIssue) return new Response(JSON.stringify({ ...createdIssue, state: 'open' }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    const { service, directory, config } = await setup(fetchMock as typeof fetch)
    await service.completeOAuth('code', 'e'.repeat(64), 'e'.repeat(64))
    const store = new MemoryRunStore()
    const tools = new ToolRegistry({ mockMode: false, github: service })
    const provider = new MockLlmProvider()
    const verification = new VerificationService(tools, config)
    const execution = new ExecutionService(store, tools, verification, config)
    const approvals = new ApprovalService(store, execution)
    const agent = new AgentService(store, new PlanningService(store, tools, provider, config), execution, approvals, provider, config)
    const repo = { owner: 'octo', name: 'launchpilot' }
    const run = await agent.create({ goal: 'Review the repository and create an issue for any documentation gaps.', repository: repo })
    expect(run.state).toBe('awaiting_approval')
    const proposed = run.plan?.steps.find(step => step.toolName === 'create_github_issue')!
    expect(proposed.status).toBe('awaiting_approval')
    expect(createdIssue).toBeUndefined()
    const completed = await agent.decide(run.id, proposed.id, proposed.approvalDigest!, 'approve')
    expect(createdIssue?.number).toBe(42)
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/issues') && init?.method === 'POST')).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/issues/42'))).toBe(true)
    expect(completed.state).toBe('completed')
    expect(completed.goalStatus).toBe('achieved')
    expect(completed.verifications.find(result => result.label === 'GitHub issue exists')?.status).toBe('passed')
    const retryResult = await tools.execute('create_github_issue', { owner: repo.owner, name: repo.name, title: `Follow up: ${run.goal.slice(0, 150)}`, body: `Created by an explicitly approved LaunchPilot action for run ${run.id}.\n\nGoal: ${run.goal}` }, { config, repository: repo, runId: run.id }, true)
    expect(retryResult).toMatchObject({ deduplicated: true, number: 42 })
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/issues') && init?.method === 'POST')).toHaveLength(1)
    await rm(directory, { recursive: true, force: true })
  })
})
