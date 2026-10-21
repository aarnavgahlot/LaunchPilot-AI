import { z } from 'zod'
import { randomUUID } from 'node:crypto'

export const RunStates = ['queued', 'planning', 'awaiting_input', 'awaiting_approval', 'executing', 'verifying', 'completed', 'partially_completed', 'failed', 'cancelled'] as const
export type RunState = typeof RunStates[number]
export const RiskSchema = z.enum(['low', 'medium', 'high', 'high_impact'])
export type Risk = z.infer<typeof RiskSchema>

export const RepoSchema = z.object({ owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/), name: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/).refine(name => name !== '.' && name !== '..') }).strict()
export type Repository = z.infer<typeof RepoSchema>

export const ToolNames = ['list_accessible_repositories', 'inspect_repository', 'read_repository_file', 'list_repository_issues', 'list_repository_pull_requests', 'inspect_repository_structure', 'prepare_readme_change', 'create_github_issue', 'create_documentation_pull_request', 'verify_github_issue', 'verify_documentation_pull_request', 'verify_repository_file'] as const
export type ToolName = typeof ToolNames[number]

export const PlanStepSchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(600),
  toolName: z.enum(ToolNames),
  risk: RiskSchema,
  permission: z.enum(['none', 'repository:read', 'issue:write', 'contents:write', 'pull_request:write']),
  additionalPermissions: z.array(z.enum(['repository:read', 'issue:write', 'contents:write', 'pull_request:write'])).default([]),
  requiresApproval: z.boolean(),
  approvalDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  approvalPreview: z.unknown().optional(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval', 'rejected']).default('pending'),
  result: z.unknown().optional(),
  error: z.string().optional(),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const ExecutionPlanSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(1000),
  clarificationQuestion: z.string().max(500).nullable(),
  steps: z.array(PlanStepSchema).min(1).max(8),
}).strict()
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>

export const ApprovalSchema = z.object({ actionId: z.string().min(1).max(60), decision: z.enum(['approve', 'reject']), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const CreateRunSchema = z.object({ goal: z.string().trim().min(8).max(2000), repository: RepoSchema.optional(), readOnly: z.boolean().optional() }).strict()
export type CreateRunInput = z.infer<typeof CreateRunSchema>

export type RunEvent = { id: string; at: string; type: string; message: string; stepId?: string; data?: unknown }
export type Verification = { id: string; label: string; status: 'passed' | 'failed' | 'inconclusive'; detail: string; evidence?: unknown; verifiedAt: string }
export type ActionDecision = { actionId: string; digest: string; decision: 'approve' | 'reject'; decidedAt: string; decidedBy: 'user' }
export type GoalStatus = 'achieved' | 'partially_achieved' | 'unverified'
export type AgentRun = {
  id: string; goal: string; repository?: Repository; readOnly?: boolean; state: RunState; mode: 'mock' | 'openai'; githubMode: 'mock' | 'live'; createdAt: string; updatedAt: string;
  plan?: ExecutionPlan; events: RunEvent[]; verifications: Verification[]; decisions: ActionDecision[]; result?: string; goalStatus?: GoalStatus; clarificationQuestion?: string;
  continuationCount: number; executionLock?: string; cancellationRequested?: boolean;
  idempotencyKey?: string;
}

export function newId(prefix: string) { return `${prefix}_${randomUUID()}` }
