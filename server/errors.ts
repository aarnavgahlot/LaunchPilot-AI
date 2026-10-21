export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); this.name = 'AppError' }
}
export function safeError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof AppError) return { statusCode: error.statusCode, code: error.code, message: error.message }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }
}
