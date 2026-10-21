import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Response } from 'express'
import type { AppConfig } from '../config.js'
import { AppError } from '../errors.js'

const apiBase = 'https://api.github.com'
const webBase = 'https://github.com'
const apiVersion = '2026-03-10'
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const stateCookie = 'launchpilot_github_oauth_state'
type TokenRecord = { accessToken: string; refreshToken?: string; accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string; login: string; avatarUrl?: string; connectedAt: string }
type RepositoryInfo = { id: number; name: string; full_name: string; description: string | null; default_branch: string; private: boolean; language: string | null; stargazers_count: number; open_issues_count: number; updated_at: string; html_url: string; permissions?: Record<string, boolean> }

export type GitHubRepository = { id: number; owner: string; name: string; fullName: string; description: string | null; defaultBranch: string; private: boolean; language: string | null; stars: number; openIssues: number; updatedAt: string; url: string; canWriteContents: boolean; canWriteIssues: boolean; canWritePullRequests: boolean }

export class GitHubConnectionService {
  private readonly vaultPath: string
  private tokenRecord?: TokenRecord
  private refreshPromise?: Promise<TokenRecord>
  constructor(private readonly config: AppConfig) { this.vaultPath = resolve(config.DATA_DIR, 'github-connection.enc') }

  get isConfigured() { return this.config.GITHUB_MODE === 'live' }
  get permissionsDescription() {
    return ['Repository metadata: read', 'Contents: read', 'Issues: read and write (issue creation requires your approval)', 'Pull requests: read', ...(this.config.GITHUB_APP_CONTENTS_WRITE === 'true' ? ['Contents: write and pull requests: write (optional documentation branch/PR actions; each requires approval)'] : [])]
  }
  async status() {
    if (!this.isConfigured) return { configured: false, connected: false, mode: 'mock' as const, status: 'mock' as const, user: null, permissions: this.permissionsDescription }
    try {
      const record = await this.getRecord()
      return { configured: true, connected: true, mode: 'live' as const, status: 'connected' as const, user: { login: record.login, avatarUrl: record.avatarUrl }, connectedAt: record.connectedAt, permissions: this.permissionsDescription, error: undefined }
    } catch (error) {
      if (error instanceof AppError && error.code === 'GITHUB_NOT_CONNECTED') return { configured: true, connected: false, mode: 'live' as const, status: 'disconnected' as const, user: null, permissions: this.permissionsDescription, error: undefined }
      return { configured: true, connected: false, mode: 'live' as const, status: 'error' as const, user: null, permissions: this.permissionsDescription, error: 'The encrypted GitHub connection needs attention. Reconnect the account.' }
    }
  }
  authorizationUrl(state: string) {
    const url = new URL('/login/oauth/authorize', webBase)
    url.searchParams.set('client_id', this.config.GITHUB_APP_CLIENT_ID!)
    url.searchParams.set('redirect_uri', this.config.GITHUB_APP_CALLBACK_URL!)
    url.searchParams.set('state', state)
    url.searchParams.set('allow_signup', 'false')
    url.searchParams.set('scope', 'offline_access')
    return url.toString()
  }
  setStateCookie(res: Response, state: string) {
    res.cookie(stateCookie, state, { httpOnly: true, secure: this.config.NODE_ENV === 'production', sameSite: 'lax', path: '/api/integrations/github', maxAge: 10 * 60 * 1000 })
  }
  async completeOAuth(code: string, state: string, requestState: string | undefined) {
    const expectedState = Buffer.from(state), actualState = Buffer.from(requestState ?? '')
    if (!requestState || expectedState.length !== actualState.length || !timingSafeEqual(expectedState, actualState)) throw new AppError(400, 'GITHUB_OAUTH_STATE_INVALID', 'GitHub authorization could not be validated. Start the connection again.')
    const tokenResponse = await this.fetchOAuth('/login/oauth/access_token', { client_id: this.config.GITHUB_APP_CLIENT_ID, client_secret: this.config.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: this.config.GITHUB_APP_CALLBACK_URL })
    if (!tokenResponse.access_token) throw new AppError(502, 'GITHUB_OAUTH_FAILED', 'GitHub did not provide an access token. Check the app callback configuration and try again.')
    const profile = await this.githubRequest<{ login: string; avatar_url: string }>('/user', tokenResponse.access_token)
    const record: TokenRecord = { accessToken: tokenResponse.access_token, refreshToken: tokenResponse.refresh_token, accessTokenExpiresAt: tokenResponse.expires_in ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString() : undefined, refreshTokenExpiresAt: tokenResponse.refresh_token_expires_in ? new Date(Date.now() + tokenResponse.refresh_token_expires_in * 1000).toISOString() : undefined, login: profile.login, avatarUrl: profile.avatar_url, connectedAt: new Date().toISOString() }
    await this.saveRecord(record)
  }
  async disconnect() {
    const record = await this.getRecord().catch(() => undefined)
    if (record && this.isConfigured) {
      try {
        const response = await fetch(`${apiBase}/applications/${encodeURIComponent(this.config.GITHUB_APP_CLIENT_ID!)}/grant`, { method: 'DELETE', headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${Buffer.from(`${this.config.GITHUB_APP_CLIENT_ID}:${this.config.GITHUB_APP_CLIENT_SECRET}`).toString('base64')}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: record.accessToken }), signal: AbortSignal.timeout(this.config.REQUEST_TIMEOUT_MS) })
        if (!response.ok && response.status !== 404) throw new AppError(502, 'GITHUB_REVOCATION_FAILED', 'GitHub could not revoke this authorization. Try again; the saved credential was retained.')
      } catch {
        await this.clearRecord()
        throw new AppError(502, 'GITHUB_REVOCATION_FAILED', 'The local connection was deleted, but GitHub could not confirm revocation. Revoke LaunchPilot in GitHub settings to finish disconnecting.')
      }
    }
    await this.clearRecord()
  }
  async listRepositories(): Promise<GitHubRepository[]> {
    const token = await this.getAccessToken()
    const result: RepositoryInfo[] = []
    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.githubRequest<RepositoryInfo[]>(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member`, token)
      result.push(...batch)
      if (batch.length < 100) break
    }
    return result.map(toRepository)
  }
  async assertRepository(owner: string, name: string) {
    const token = await this.getAccessToken()
    const repo = await this.githubRequest<RepositoryInfo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token)
    if (`${repo.full_name}`.toLowerCase() !== `${owner}/${name}`.toLowerCase()) throw new AppError(403, 'GITHUB_REPOSITORY_NOT_AUTHORIZED', 'This repository is not available to the connected GitHub account.')
    return { repository: toRepository(repo), token }
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken()
    return this.githubRequest<T>(path, token, init)
  }
  private async getAccessToken() { return (await this.getRecord()).accessToken }
  private async getRecord(): Promise<TokenRecord> {
    if (this.tokenRecord) {
      if (this.tokenRecord.accessTokenExpiresAt && Date.parse(this.tokenRecord.accessTokenExpiresAt) < Date.now() + 60_000) return this.refresh()
      return this.tokenRecord
    }
    try {
      const envelope = JSON.parse(await readFile(this.vaultPath, 'utf8')) as { iv: string; tag: string; data: string }
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.GITHUB_TOKEN_ENCRYPTION_KEY!, 'base64'), Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      this.tokenRecord = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) as TokenRecord
      if (this.tokenRecord.accessTokenExpiresAt && Date.parse(this.tokenRecord.accessTokenExpiresAt) < Date.now() + 60_000) return this.refresh()
      return this.tokenRecord
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError(401, 'GITHUB_NOT_CONNECTED', 'Connect a GitHub account before selecting a repository.')
      if (error instanceof AppError) throw error
      throw new AppError(500, 'GITHUB_CREDENTIAL_STORE_ERROR', 'The encrypted GitHub connection could not be read. Reconnect the account.') }
  }
  private async refresh() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      const current = this.tokenRecord ?? await this.readRecordOnly()
      if (!current.refreshToken || (current.refreshTokenExpiresAt && Date.parse(current.refreshTokenExpiresAt) <= Date.now())) { await this.clearRecord(); throw new AppError(401, 'GITHUB_TOKEN_EXPIRED', 'The GitHub connection expired. Reconnect the account.') }
      const result = await this.fetchOAuth('/login/oauth/access_token', { client_id: this.config.GITHUB_APP_CLIENT_ID, client_secret: this.config.GITHUB_APP_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: current.refreshToken })
      if (!result.access_token || !result.refresh_token) throw new AppError(502, 'GITHUB_TOKEN_REFRESH_FAILED', 'GitHub could not refresh the connection. Reconnect the account.')
      const updated = { ...current, accessToken: result.access_token, refreshToken: result.refresh_token, accessTokenExpiresAt: new Date(Date.now() + (result.expires_in ?? 28800) * 1000).toISOString(), refreshTokenExpiresAt: result.refresh_token_expires_in ? new Date(Date.now() + result.refresh_token_expires_in * 1000).toISOString() : current.refreshTokenExpiresAt }
      await this.saveRecord(updated)
      return updated
    })()
    try { return await this.refreshPromise } finally { this.refreshPromise = undefined }
  }
  private async readRecordOnly(): Promise<TokenRecord> {
    const cached = this.tokenRecord; this.tokenRecord = undefined
    try { return await this.getRecord() } finally { this.tokenRecord = cached }
  }
  private async saveRecord(record: TokenRecord) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(this.config.GITHUB_TOKEN_ENCRYPTION_KEY!, 'base64'), iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()])
    const envelope = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
    const temp = `${this.vaultPath}.${randomBytes(5).toString('hex')}.tmp`
    await writeFile(temp, envelope, { mode: 0o600 })
    await rename(temp, this.vaultPath)
    this.tokenRecord = record
  }
  private async clearRecord() {
    this.tokenRecord = undefined
    const { rm } = await import('node:fs/promises')
    await rm(this.vaultPath, { force: true })
  }
  private async fetchOAuth(path: string, body: Record<string, unknown>) {
    let response: globalThis.Response
    try { response = await fetch(`${webBase}${path}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.REQUEST_TIMEOUT_MS) }) }
    catch { throw new AppError(502, 'GITHUB_OAUTH_UNAVAILABLE', 'GitHub authorization is unavailable. Check network access and try again.') }
    let data: { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; error?: string }
    try { data = await response.json() as typeof data }
    catch { throw new AppError(502, 'GITHUB_OAUTH_INVALID_RESPONSE', 'GitHub returned an unreadable authorization response. Check the app configuration and retry.') }
    if (!response.ok || data.error) throw new AppError(502, 'GITHUB_OAUTH_FAILED', 'GitHub could not complete authorization. Check the GitHub App settings and try again.')
    return data
  }
  private async githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase()
    const retrySafe = method === 'GET' || method === 'HEAD'
    let response: globalThis.Response | undefined
    for (let attempt = 0; attempt < (retrySafe ? 3 : 1); attempt += 1) {
      try {
        response = await fetch(`${apiBase}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'LaunchPilot-AI', 'X-GitHub-Api-Version': apiVersion, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }, signal: AbortSignal.timeout(this.config.REQUEST_TIMEOUT_MS) })
      } catch {
        if (!retrySafe || attempt === 2) throw new AppError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached. Check the connection and retry.')
        await delay(250 * (2 ** attempt))
        continue
      }
      const retryStatus = [408, 425, 429, 500, 502, 503, 504].includes(response.status) || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      if (!retrySafe || !retryStatus || attempt === 2) break
      const header = response.headers.get('retry-after')
      const reset = response.headers.get('x-ratelimit-reset')
      const serverWait = header ? Number(header) * 1000 : reset && response.headers.get('x-ratelimit-remaining') === '0' ? Math.max(0, Number(reset) * 1000 - Date.now()) : undefined
      const waitMs = serverWait ?? 250 * (2 ** attempt)
      // Honor GitHub's requested delay, but leave long rate-limit waits to the caller.
      if (waitMs > Math.min(this.config.REQUEST_TIMEOUT_MS, 5000)) break
      await response.body?.cancel()
      await delay(waitMs)
    }
    if (!response) throw new AppError(502, 'GITHUB_UNAVAILABLE', 'GitHub could not be reached. Check the connection and retry.')
    if (!response.ok) {
      if (response.status === 404) throw new AppError(404, 'GITHUB_NOT_FOUND', 'The repository or resource was not found, or the GitHub App lacks access.')
      const remaining = response.headers.get('x-ratelimit-remaining'), reset = response.headers.get('x-ratelimit-reset')
      if (response.status === 429 || (response.status === 403 && (remaining === '0' || response.headers.has('retry-after')))) {
        const wait = response.headers.get('retry-after') ?? (reset ? String(Math.max(1, Number(reset) - Math.floor(Date.now() / 1000))) : '60')
        throw new AppError(429, 'GITHUB_RATE_LIMIT', `GitHub rate limit reached. Retry in about ${wait} seconds.`)
      }
      if (response.status === 401) {
        if (this.tokenRecord?.accessToken === token) await this.clearRecord().catch(() => { this.tokenRecord = undefined })
        throw new AppError(401, 'GITHUB_TOKEN_INVALID', 'GitHub rejected the connection. Reconnect your account.')
      }
      if (response.status === 403) {
        const accepted = response.headers.get('x-accepted-github-permissions')
        throw new AppError(403, 'GITHUB_PERMISSION_MISSING', `The GitHub App is missing a required permission${accepted ? ` (${accepted})` : ''}. Update its permissions and reconnect.`)
      }
      throw new AppError(502, 'GITHUB_API_ERROR', `GitHub returned an API error (${response.status}). Check repository permissions and retry.`)
    }
    if (response.status === 204 || method === 'HEAD') return undefined as T
    try { return await response.json() as T }
    catch { throw new AppError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned a response LaunchPilot could not read. Check the connection and retry.') }
  }
}

function toRepository(repo: RepositoryInfo): GitHubRepository {
  const owner = repo.full_name.split('/')[0] ?? ''
  return { id: repo.id, owner, name: repo.name, fullName: repo.full_name, description: repo.description, defaultBranch: repo.default_branch, private: repo.private, language: repo.language, stars: repo.stargazers_count, openIssues: repo.open_issues_count, updatedAt: repo.updated_at, url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}`, canWriteContents: Boolean(repo.permissions?.push), canWriteIssues: Boolean(repo.permissions?.push), canWritePullRequests: Boolean(repo.permissions?.push) }
}
