export type ErrorCategory = "authentication" | "authorization" | "configuration" | "network" | "provider" | "rate_limit" | "database" | "runtime" | "build" | "resource" | "timeout" | "validation";

const RULES: [ErrorCategory, RegExp, boolean][] = [
  ["rate_limit", /rate.?limit|too many requests|\b429\b|quota/i, true],
  ["timeout", /timed? ?out|timeout|deadline exceeded|ETIMEDOUT/i, true],
  ["resource", /out of memory|heap limit|ENOMEM|ENOSPC|killed|exit code 137/i, false],
  ["authentication", /unauthori[sz]ed|\b401\b|invalid (api )?key|invalid token|not authenticated|expired token/i, false],
  ["authorization", /forbidden|\b403\b|permission denied|not allowed|row-level security/i, false],
  ["validation", /invalid arguments|validation|expected .* received|schema/i, false],
  ["configuration", /not configured|missing (env|environment|setting|token)|no .* linked|no .* saved|not set/i, false],
  ["database", /postgres|sql|relation .* does not exist|duplicate key|violates/i, false],
  ["build", /build failed|tsc|type error|cannot find module|compil|lint/i, false],
  ["network", /ECONNRESET|ENOTFOUND|fetch failed|network|socket hang up|EAI_AGAIN/i, true],
  ["provider", /\b5\d\d\b|overloaded|bad gateway|service unavailable|model/i, true],
];

/** Redact secrets so stored and displayed errors are safe. */
export function redact(text: string, max = 500): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]")
    .replace(/\b(sk|pk|rk|sb|ghp|gho|ghu|ghs|ghr|github_pat|xox[abp]|glpat|hf|npm|pypi)[-_][\w-]{8,}/gi, "[redacted-key]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-aws-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted-google-key]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\bBearer\s+[^\s"'<>]{8,}/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+)[^\s"',]{6,}/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function classifyError(text: string): { category: ErrorCategory; retryable: boolean } {
  for (const [category, re, retryable] of RULES) if (re.test(text)) return { category, retryable };
  return { category: "runtime", retryable: false };
}
