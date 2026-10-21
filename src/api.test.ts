import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('frontend API error handling', () => {
  it('preserves safe JSON errors returned by the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'GITHUB_NOT_CONNECTED', message: 'Connect GitHub first.' } }), { status: 401, headers: { 'content-type': 'application/json' } })))
    await expect(api.integrations()).rejects.toThrow('Connect GitHub first.')
  })

  it('handles proxy HTML and non-JSON errors without throwing a JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>upstream unavailable</html>', { status: 502, headers: { 'content-type': 'text/html' } })))
    await expect(api.integrations()).rejects.toThrow('LaunchPilot API request failed (502)')
  })

  it('reports invalid successful API responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(api.integrations()).rejects.toThrow('returned invalid JSON')
  })

  it('reports when the API server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network failed')))
    await expect(api.integrations()).rejects.toThrow('LaunchPilot API is unavailable')
  })
})
