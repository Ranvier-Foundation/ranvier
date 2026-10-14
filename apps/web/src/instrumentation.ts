import { cspDelivery } from '@/lib/security/csp';

/**
 * Runs once when the server starts (Next.js instrumentation hook). Says loudly when the CSP is
 * sent as Report-Only (staging) or when a stray CSP_REPORT_ONLY=1 is being ignored (ADR 0008).
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { warning } = cspDelivery({
    CSP_REPORT_ONLY: process.env.CSP_REPORT_ONLY,
    RANVIER_ENV: process.env.RANVIER_ENV,
  });
  if (warning) console.warn(`\n[security] ${warning}\n`);
}
