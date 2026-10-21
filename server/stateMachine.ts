import type { RunState } from './domain.js'

const transitions: Record<RunState, readonly RunState[]> = {
  queued: ['planning', 'awaiting_input', 'executing', 'cancelled', 'failed'],
  planning: ['awaiting_input', 'awaiting_approval', 'executing', 'verifying', 'completed', 'failed', 'cancelled'],
  awaiting_input: ['queued', 'cancelled'],
  awaiting_approval: ['executing', 'partially_completed', 'cancelled', 'failed'],
  executing: ['awaiting_approval', 'verifying', 'partially_completed', 'failed', 'cancelled'],
  verifying: ['completed', 'partially_completed', 'failed', 'cancelled'],
  completed: ['verifying'], partially_completed: ['queued', 'verifying'], failed: ['queued'], cancelled: [],
}

export function assertTransition(from: RunState, to: RunState) {
  if (!transitions[from].includes(to)) throw new Error(`Invalid run state transition: ${from} -> ${to}`)
}

export function transition(from: RunState, to: RunState): RunState {
  assertTransition(from, to)
  return to
}
