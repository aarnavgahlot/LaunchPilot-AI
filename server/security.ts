const sensitivePatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
]
export function redactUntrusted(value: string): string { return sensitivePatterns.reduce((result, pattern, index) => result.replace(pattern, index === 3 ? '$1[REDACTED]' : '[REDACTED]'), value).slice(0, 4000) }
