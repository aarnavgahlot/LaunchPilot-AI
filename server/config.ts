import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATA_DIR: z.string().default('./data'),
  LLM_MODE: z.enum(['mock', 'openai']).default('mock'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  GITHUB_MODE: z.enum(['mock', 'live']).default('mock'),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_CALLBACK_URL: z.string().url().optional(),
  GITHUB_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GITHUB_APP_CONTENTS_WRITE: z.enum(['true', 'false']).default('false'),
  GITHUB_READINESS_REQUIREMENTS: z.string().default('readme,setup,license,demo,contributing'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  RUN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(30),
})

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) throw new Error(`Invalid environment configuration: ${parsed.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; ')}`)
if (parsed.data.LLM_MODE === 'openai' && !parsed.data.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when LLM_MODE=openai')
if (parsed.data.GITHUB_MODE === 'live' && (!parsed.data.GITHUB_APP_CLIENT_ID || !parsed.data.GITHUB_APP_CLIENT_SECRET || !parsed.data.GITHUB_APP_CALLBACK_URL || !parsed.data.GITHUB_TOKEN_ENCRYPTION_KEY)) throw new Error('GitHub App client ID, client secret, callback URL, and a 32-byte GITHUB_TOKEN_ENCRYPTION_KEY are required when GITHUB_MODE=live')
if (parsed.data.GITHUB_MODE === 'live' && Buffer.from(parsed.data.GITHUB_TOKEN_ENCRYPTION_KEY!, 'base64').length !== 32) throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
const readinessKeys = new Set(['readme', 'setup', 'license', 'demo', 'contributing', 'codeofconduct', 'security', 'changelog'])
const invalidReadinessKeys = parsed.data.GITHUB_READINESS_REQUIREMENTS.split(',').map(value => value.trim().toLowerCase()).filter(value => value && !readinessKeys.has(value))
if (invalidReadinessKeys.length) throw new Error(`Unsupported GITHUB_READINESS_REQUIREMENTS: ${invalidReadinessKeys.join(', ')}`)

export const config = {
  ...parsed.data,
  readinessRequirements: parsed.data.GITHUB_READINESS_REQUIREMENTS.split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
}
export type AppConfig = typeof config
