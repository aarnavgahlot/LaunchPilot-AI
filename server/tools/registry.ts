import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { RepoSchema, type Repository, type ToolName } from '../domain.js'
import { AppError } from '../errors.js'
import { redactUntrusted } from '../security.js'
import type { GitHubConnectionService } from '../github/connection.js'

export type ToolContext = { config: AppConfig; repository?: Repository; runId: string; github?: GitHubConnectionService }
type Permission = 'none' | 'repository:read' | 'issue:write' | 'contents:write' | 'pull_request:write'
export type ToolDefinition<I = unknown, O = unknown> = {
  name: ToolName; description: string; schema: z.ZodType<I>; jsonSchema: Record<string, unknown>;
  permission: Permission; additionalPermissions?: Permission[]; risk: 'low' | 'medium' | 'high' | 'high_impact'; requiresApproval: boolean; modelCallable: boolean; timeoutMs: number;
  execute: (input: I, context: ToolContext) => Promise<O>
}

const RepositoryInput = z.object({ owner: z.string(), name: z.string() }).strict()
const FileInput = z.object({ owner: z.string(), name: z.string(), path: z.string() }).strict()
const IssueInput = z.object({ owner: z.string(), name: z.string(), title: z.string().min(5).max(200), body: z.string().max(8000) }).strict()
const VerifyIssueInput = z.object({ owner: z.string(), name: z.string(), number: z.number().int().positive(), expectedTitle: z.string().min(1).max(200), marker: z.string().min(1).max(160) }).strict()
const VerifyFileInput = z.object({ owner: z.string(), name: z.string(), path: z.string(), expectedContent: z.string().max(20000) }).strict()
const repoJson = { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' } }, required: ['owner', 'name'], additionalProperties: false }
const fileJson = { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' } }, required: ['owner', 'name', 'path'], additionalProperties: false }
const allowedTextFiles = new Set(['README.md', 'README.rst', 'README', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', '.github/CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/bug_report.md'])

function repoRef(input: { owner: string; name: string }, context: ToolContext): Repository {
  const parsed = RepoSchema.parse({ owner: input.owner, name: input.name })
  const owner = parsed.owner.toLowerCase(), name = parsed.name.toLowerCase()
  const repository = { owner, name }
  const key = `${owner}/${name}`
  void key
  return repository
}
function githubHtmlUrl(repo: Repository, path: string) { return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${path}` }

async function github<T>(path: string, context: ToolContext, init: RequestInit = {}): Promise<T> {
  if (!context.github) throw new AppError(503, 'GITHUB_NOT_CONFIGURED', 'The GitHub connection service is unavailable.')
  if (context.repository) await context.github.assertRepository(context.repository.owner, context.repository.name)
  return context.github.request<T>(path, init)
}
async function githubPages<T>(path: string, context: ToolContext, pageLimit = 3): Promise<T[]> {
  const rows: T[] = []
  for (let page = 1; page <= pageLimit; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const batch = await github<T[]>(`${path}${separator}per_page=100&page=${page}`, context)
    rows.push(...batch)
    if (batch.length < 100) break
  }
  return rows
}

type RegistryOptions = { mockMode: boolean; github?: GitHubConnectionService }
export class ToolRegistry {
  private tools = new Map<ToolName, ToolDefinition<any, any>>()
  constructor(private readonly options: RegistryOptions) {
    this.register({ name: 'list_accessible_repositories', description: 'List repositories that the connected GitHub user has authorized the GitHub App to access.', schema: z.object({}).strict(), jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: false, timeoutMs: 20000, execute: async (_input, context) => {
      if (options.mockMode) return { mode: 'mock', repositories: [] }
      if (!context.github) throw new AppError(401, 'GITHUB_NOT_CONNECTED', 'Connect a GitHub account before listing repositories.')
      return { repositories: await context.github.listRepositories() }
    } })
    this.register({ name: 'inspect_repository', description: 'Inspect basic metadata for the allowlisted GitHub repository.', schema: RepositoryInput, jsonSchema: repoJson, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: true, timeoutMs: 15000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) return { mode: 'mock', fullName: `${repo.owner}/${repo.name}`, description: 'Sample repository metadata', defaultBranch: 'main', private: false, openIssuesCount: 3 }
      const data = await github<{ full_name: string; description: string | null; default_branch: string; private: boolean; open_issues_count: number; html_url: string; language: string | null; permissions?: Record<string, boolean> }>(`/repos/${repo.owner}/${repo.name}`, context)
      const languages = await github<Record<string, number>>(`/repos/${repo.owner}/${repo.name}/languages`, context)
      return { fullName: data.full_name, description: data.description, defaultBranch: data.default_branch, private: data.private, openIssuesCount: data.open_issues_count, htmlUrl: data.html_url, language: data.language, languages, permissions: data.permissions }
    } })
    this.register({ name: 'read_repository_file', description: 'Read one permitted text file from the allowlisted repository.', schema: FileInput, jsonSchema: fileJson, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: true, timeoutMs: 15000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (!allowedTextFiles.has(input.path)) throw new AppError(400, 'FILE_NOT_ALLOWED', 'This file path is not permitted.')
      if (options.mockMode) return { mode: 'mock', path: input.path, exists: input.path.startsWith('README') || input.path === 'package.json', content: input.path.startsWith('README') ? '# Sample repository\n\nA development project used for the LaunchPilot prototype.\n\n## Setup\n\nInstall dependencies and run the app.\n' : null }
      const endpoint = input.path === 'README.md' ? `/repos/${repo.owner}/${repo.name}/readme` : `/repos/${repo.owner}/${repo.name}/contents/${input.path.split('/').map(encodeURIComponent).join('/')}`
      const data = await github<{ type: string; size: number; content?: string; encoding?: string; path?: string }>(endpoint, context)
      if (data.type !== 'file' || data.size > 20000 || data.encoding !== 'base64' || !data.content) throw new AppError(422, 'FILE_UNSUPPORTED', 'The requested file is not a supported text file or exceeds the size limit.')
      return { path: data.path ?? input.path, exists: true, content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8').slice(0, 20000) }
    } })
    this.register({ name: 'list_repository_issues', description: 'List a bounded set of issues for the allowlisted repository. Pull requests are excluded.', schema: RepositoryInput, jsonSchema: repoJson, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: true, timeoutMs: 15000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) return { mode: 'mock', issues: [{ number: 12, title: 'Clarify local development setup', state: 'open', labels: [] }, { number: 8, title: 'Add contribution guide', state: 'open', labels: ['documentation'] }] }
      const data = await githubPages<{ number: number; title: string; state: string; labels: Array<{ name: string }>; pull_request?: unknown; updated_at: string }>(`/repos/${repo.owner}/${repo.name}/issues?state=open&sort=updated&direction=desc`, context)
      return { issues: data.filter(item => !item.pull_request).map(({ number, title, state, labels, updated_at }) => ({ number, title, state, url: githubHtmlUrl(repo, `issues/${number}`), labels: labels.map(label => label.name), updatedAt: updated_at })) }
    } })
    this.register({ name: 'list_repository_pull_requests', description: 'List open pull requests for the selected repository.', schema: RepositoryInput, jsonSchema: repoJson, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: true, timeoutMs: 15000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) return { mode: 'mock', pullRequests: [] }
      const data = await githubPages<{ number: number; title: string; state: string; html_url: string; updated_at: string }>(`/repos/${repo.owner}/${repo.name}/pulls?state=open&sort=updated&direction=desc`, context)
      return { pullRequests: data.map(({ number, title, state, updated_at }) => ({ number, title, state, url: githubHtmlUrl(repo, `pull/${number}`), updatedAt: updated_at })) }
    } })
    this.register({ name: 'inspect_repository_structure', description: 'Inspect the default branch file tree and check configurable project documentation files.', schema: RepositoryInput, jsonSchema: repoJson, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: true, timeoutMs: 20000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) {
        const documentation = { readme: true, contributing: false, license: false, codeOfConduct: false, security: false, demo: false, changelog: false, setup: true }
        return { mode: 'mock', files: ['README.md', 'package.json'], requirements: context.config.readinessRequirements ?? ['readme', 'setup', 'license', 'demo', 'contributing'], checks: (context.config.readinessRequirements ?? ['readme', 'setup', 'license', 'demo', 'contributing']).map(name => ({ name, present: Boolean(documentation[name as keyof typeof documentation]) })) }
      }
      const metadata = await github<{ default_branch: string }>(`/repos/${repo.owner}/${repo.name}`, context)
      const ref = await github<{ object: { sha: string } }>(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, context)
      const tree = await github<{ tree: Array<{ path: string; type: string }> }>(`/repos/${repo.owner}/${repo.name}/git/trees/${ref.object.sha}?recursive=1`, context)
      const files = tree.tree.filter(item => item.type === 'blob').map(item => item.path).slice(0, 2000)
      const has = (...names: string[]) => names.some(name => files.some(path => path.toLowerCase() === name.toLowerCase()))
      const documentation = { readme: has('README.md', 'README.rst', 'README'), contributing: has('CONTRIBUTING.md', '.github/CONTRIBUTING.md'), license: has('LICENSE', 'LICENSE.md', 'LICENSE.txt'), codeOfConduct: has('CODE_OF_CONDUCT.md'), security: has('SECURITY.md'), demo: has('DEMO.md', 'DEMO', 'docs/demo.md'), changelog: has('CHANGELOG.md', 'CHANGES.md'), setup: has('package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Makefile') }
      const requirements = context.config.readinessRequirements ?? ['readme', 'setup', 'license', 'demo', 'contributing']
      const keys: Record<string, keyof typeof documentation> = { readme: 'readme', setup: 'setup', license: 'license', demo: 'demo', contributing: 'contributing', codeofconduct: 'codeOfConduct', security: 'security', changelog: 'changelog' }
      const candidates: Record<string, string[]> = { readme: ['README.md', 'README.rst', 'README'], setup: ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Makefile'], license: ['LICENSE', 'LICENSE.md', 'LICENSE.txt'], demo: ['DEMO.md', 'DEMO', 'docs/demo.md'], contributing: ['CONTRIBUTING.md', '.github/CONTRIBUTING.md'], codeofconduct: ['CODE_OF_CONDUCT.md'], security: ['SECURITY.md'], changelog: ['CHANGELOG.md', 'CHANGES.md'] }
      return { files, truncated: tree.tree.length >= 2000, requirements, checks: requirements.map(name => { const key = keys[name]; const evidence = files.find(path => candidates[name]?.some(candidate => path.toLowerCase() === candidate.toLowerCase())) ?? null; return { name, present: Boolean(documentation[key]), evidence } }), documentation }
    } })
    this.register({ name: 'prepare_readme_change', description: 'Prepare a proposed README replacement for user review; never writes repository contents.', schema: z.object({ path: z.enum(['README.md', 'README.rst', 'README']), proposedContent: z.string().min(1).max(20000) }).strict(), jsonSchema: { type: 'object', properties: { path: { type: 'string', enum: ['README.md', 'README.rst', 'README'] }, proposedContent: { type: 'string' } }, required: ['path', 'proposedContent'], additionalProperties: false }, permission: 'repository:read', risk: 'medium', requiresApproval: false, modelCallable: false, timeoutMs: 5000, execute: async input => ({ prepared: true, writePerformed: false, path: input.path, proposedContent: input.proposedContent, note: 'Review-only proposal. No repository file was changed.' }) })
    this.register({ name: 'create_github_issue', description: 'Create one GitHub issue in the allowlisted repository. Requires explicit user approval.', schema: IssueInput, jsonSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'name', 'title', 'body'], additionalProperties: false }, permission: 'issue:write', risk: 'high', requiresApproval: true, modelCallable: false, timeoutMs: 20000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      const marker = `<!-- launchpilot-action:${context.runId} -->`
      if (options.mockMode) return { mode: 'mock', created: true, writePerformed: false, number: 901, title: input.title, url: `https://github.com/${repo.owner}/${repo.name}/issues/901`, marker }
      const existing = await githubPages<{ number: number; title: string; body: string | null; html_url: string }>(`/repos/${repo.owner}/${repo.name}/issues?state=all&sort=created&direction=desc`, context, 1)
      const duplicate = existing.find(issue => issue.body?.includes(marker))
      if (duplicate) return { created: true, deduplicated: true, number: duplicate.number, title: duplicate.title, url: duplicate.html_url, marker }
      const created = await github<{ number: number; title: string; html_url: string }>(`/repos/${repo.owner}/${repo.name}/issues`, context, { method: 'POST', body: JSON.stringify({ title: input.title, body: `${input.body}\n\n${marker}` }) })
      return { created: true, number: created.number, title: created.title, url: githubHtmlUrl(repo, `issues/${created.number}`), marker }
    } })
    this.register({ name: 'create_documentation_pull_request', description: 'Create a documentation update on a new branch and open a pull request. Requires explicit approval and GitHub App Contents: write and Pull requests: write permissions.', schema: z.object({ owner: z.string(), name: z.string(), path: z.enum(['README.md', 'README.rst', 'README']), content: z.string().min(1).max(20000), title: z.string().min(5).max(200), body: z.string().max(8000) }).strict(), jsonSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, path: { type: 'string', enum: ['README.md', 'README.rst', 'README'] }, content: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'name', 'path', 'content', 'title', 'body'], additionalProperties: false }, permission: 'contents:write', additionalPermissions: ['pull_request:write'], risk: 'high', requiresApproval: true, modelCallable: false, timeoutMs: 30000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) return { mode: 'mock', created: false, writePerformed: false, note: 'Simulated only; no branch or pull request was created.' }
      if (context.config.GITHUB_APP_CONTENTS_WRITE !== 'true') throw new AppError(403, 'GITHUB_WRITE_NOT_CONFIGURED', 'Documentation pull requests are disabled until the GitHub App is configured with Contents: write and Pull requests: write.')
      const marker = `launchpilot-${context.runId.replace(/[^a-z0-9-]/gi, '').toLowerCase()}`
      const branch = `launchpilot/${marker}`
      const existing = await github<Array<{ number: number; head: { ref: string; sha: string } }>>(`/repos/${repo.owner}/${repo.name}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&per_page=10`, context)
      if (existing[0]) return { created: true, deduplicated: true, number: existing[0].number, branch, path: input.path, commit: existing[0].head.sha, url: githubHtmlUrl(repo, `pull/${existing[0].number}`), marker }
      const metadata = await github<{ default_branch: string }>(`/repos/${repo.owner}/${repo.name}`, context)
      const baseRef = await github<{ object: { sha: string } }>(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, context)
      let branchSha: string
      try { branchSha = (await github<{ object: { sha: string } }>(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${encodeURIComponent(branch)}`, context)).object.sha }
      catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 404) throw error
        await github(`/repos/${repo.owner}/${repo.name}/git/refs`, context, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) })
        branchSha = baseRef.object.sha
      }
      if (branchSha !== baseRef.object.sha) {
        try {
          const branchFile = await github<{ type: string; encoding: string; content?: string }>(`/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(input.path)}?ref=${encodeURIComponent(branch)}`, context)
          if (branchFile.type === 'file' && branchFile.encoding === 'base64' && branchFile.content && Buffer.from(branchFile.content.replace(/\n/g, ''), 'base64').toString('utf8') === input.content) {
            const pull = await github<{ number: number; html_url: string; head: { ref: string }; title: string }>(`/repos/${repo.owner}/${repo.name}/pulls`, context, { method: 'POST', body: JSON.stringify({ title: input.title, body: `${input.body}\n\n<!-- ${marker} -->`, head: branch, base: metadata.default_branch }) })
            return { created: true, recovered: true, number: pull.number, branch, path: input.path, title: pull.title, url: githubHtmlUrl(repo, `pull/${pull.number}`), marker }
          }
        } catch (error) { if (!(error instanceof AppError) || error.statusCode !== 404) throw error }
      }
      const commit = await github<{ sha: string }>(`/repos/${repo.owner}/${repo.name}/git/commits/${branchSha}`, context)
      const tree = await github<{ sha: string }>(`/repos/${repo.owner}/${repo.name}/git/trees`, context, { method: 'POST', body: JSON.stringify({ base_tree: commit.sha, tree: [{ path: input.path, mode: '100644', type: 'blob', content: input.content }] }) })
      const newCommit = await github<{ sha: string }>(`/repos/${repo.owner}/${repo.name}/git/commits`, context, { method: 'POST', body: JSON.stringify({ message: `${input.title}\n\n${marker}`, tree: tree.sha, parents: [commit.sha] }) })
      await github(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(branch)}`, context, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) })
      const pull = await github<{ number: number; html_url: string; head: { ref: string }; title: string }>(`/repos/${repo.owner}/${repo.name}/pulls`, context, { method: 'POST', body: JSON.stringify({ title: input.title, body: `${input.body}\n\n<!-- ${marker} -->`, head: branch, base: metadata.default_branch }) })
      return { created: true, number: pull.number, branch, commit: newCommit.sha, path: input.path, title: pull.title, url: githubHtmlUrl(repo, `pull/${pull.number}`), marker }
    } })
    this.register({ name: 'verify_github_issue', description: 'Verify a created GitHub issue by checking its number, exact title, and run marker after reading it back.', schema: VerifyIssueInput, jsonSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, number: { type: 'integer' }, expectedTitle: { type: 'string' }, marker: { type: 'string' } }, required: ['owner', 'name', 'number', 'expectedTitle', 'marker'], additionalProperties: false }, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: false, timeoutMs: 15000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) return { mode: 'mock', verified: true, number: input.number, title: 'Sample issue verified', evidence: 'Deterministic development fixture; no GitHub request was made.' }
      const issue = await github<{ number: number; title: string; body: string | null; html_url: string; state: string }>(`/repos/${repo.owner}/${repo.name}/issues/${input.number}`, context)
      return { verified: issue.number === input.number && issue.title === input.expectedTitle && Boolean(issue.body?.includes(input.marker)), number: issue.number, title: issue.title, state: issue.state, markerMatched: Boolean(issue.body?.includes(input.marker)), url: githubHtmlUrl(repo, `issues/${issue.number}`) }
    } })
    this.register({ name: 'verify_documentation_pull_request', description: 'Fetch a documentation pull request and read its branch file to verify the exact approved content.', schema: z.object({ owner: z.string(), name: z.string(), number: z.number().int().positive(), branch: z.string().regex(/^launchpilot\/[a-z0-9-]{1,80}$/), path: z.enum(['README.md', 'README.rst', 'README']), expectedContent: z.string().max(20000) }).strict(), jsonSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, number: { type: 'integer' }, branch: { type: 'string' }, path: { type: 'string', enum: ['README.md', 'README.rst', 'README'] }, expectedContent: { type: 'string' } }, required: ['owner', 'name', 'number', 'branch', 'path', 'expectedContent'], additionalProperties: false }, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: false, timeoutMs: 15000, execute: async (input, context) => {
      const repo = repoRef(input, context)
      if (options.mockMode) return { mode: 'mock', verified: false, evidence: 'No GitHub resource was fetched.' }
      const pull = await github<{ number: number; html_url: string; head: { ref: string }; title: string }>(`/repos/${repo.owner}/${repo.name}/pulls/${input.number}`, context)
      const file = await github<{ type: string; encoding: string; content?: string }>(`/repos/${repo.owner}/${repo.name}/contents/${input.path}?ref=${encodeURIComponent(input.branch)}`, context)
      const contentMatches = file.type === 'file' && file.encoding === 'base64' && Boolean(file.content) && Buffer.from(file.content!.replace(/\n/g, ''), 'base64').toString('utf8') === input.expectedContent
      return { verified: pull.number === input.number && pull.head.ref === input.branch && contentMatches, number: pull.number, title: pull.title, branch: pull.head.ref, path: input.path, contentMatches, url: githubHtmlUrl(repo, `pull/${pull.number}`) }
    } })
    this.register({ name: 'verify_repository_file', description: 'Read a permitted repository file and verify its exact expected content.', schema: VerifyFileInput, jsonSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, expectedContent: { type: 'string' } }, required: ['owner', 'name', 'path', 'expectedContent'], additionalProperties: false }, permission: 'repository:read', risk: 'low', requiresApproval: false, modelCallable: false, timeoutMs: 15000, execute: async (input, context) => {
      const result = await this.execute('read_repository_file', { owner: input.owner, name: input.name, path: input.path }, context, true) as { exists: boolean; content?: string; mode?: string }
      return { verified: result.exists && result.content === input.expectedContent, path: input.path, mock: result.mode === 'mock', evidence: result.exists ? 'File was read back from the repository integration.' : 'File does not exist.' }
    } })
  }
  private register(tool: ToolDefinition<any, any>) { this.tools.set(tool.name, tool) }
  get(name: ToolName) { return this.tools.get(name) }
  modelTools() { return [...this.tools.values()].filter(tool => tool.modelCallable).map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, strict: true as const, parameters: tool.jsonSchema })) }
  async execute(name: ToolName, rawInput: unknown, context: ToolContext, approved = false): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new AppError(404, 'TOOL_NOT_FOUND', 'This tool is not available.')
    if (tool.risk === 'high_impact') throw new AppError(403, 'HIGH_IMPACT_ACTION_BLOCKED', 'High-impact actions are disabled by default and are not available in this application.')
    const input = tool.schema.safeParse(rawInput)
    if (!input.success) throw new AppError(400, 'INVALID_TOOL_ARGUMENTS', `Arguments for ${tool.name} did not pass validation.`)
    if (tool.requiresApproval && !approved) throw new AppError(403, 'APPROVAL_REQUIRED', 'This action requires user approval.')
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const safeContext = { ...context, github: context.github ?? this.options.github }
      return await Promise.race([tool.execute(input.data, safeContext), new Promise((_, reject) => { timeout = setTimeout(() => reject(new AppError(504, 'TOOL_TIMEOUT', `Tool ${name} timed out.`)), tool.timeoutMs) })]).then(value => scrub(value))
    } finally { if (timeout) clearTimeout(timeout) }
  }
  permissions(name: ToolName) { const tool = this.tools.get(name); return tool ? { permission: tool.permission, additionalPermissions: tool.additionalPermissions ?? [], risk: tool.risk, requiresApproval: tool.requiresApproval } : undefined }
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return redactUntrusted(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]))
  return value
}
