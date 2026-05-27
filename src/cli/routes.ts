/**
 * `cadence routes` — read-only diagnostic.
 *
 * Prints the resolved provider+model+baseUrl for each routed phase
 * (review, council, bugbot_triage) with per-field source attribution.
 * Also lists `implement` as runtime-bound (Claude Code's session
 * model is not overridable from outside).
 *
 * Mirrors `cadence profile show`'s resolver semantics — fails loudly on
 * profile errors so the user sees the same diagnostic they'd hit from
 * `autopilot` / `run`.
 */
import { resolveProfile } from '../core/profile/resolver.ts';
import { resolvePhaseRoute, type ResolvedPhaseRoute } from '../core/phases/resolve-phase-route.ts';
import { ROUTED_PHASES, type PhaseName } from '../core/phases/provider-registry.ts';
import type { ProfileConfig } from '../core/profile/types.ts';

export interface RoutesOptions {
  cwd: string;
  flagProfile?: string;
}

function fmt(phase: string, r: ResolvedPhaseRoute): string {
  const sources = [
    `provider: ${r.sources.provider}`,
    `model: ${r.sources.model}`,
    ...(r.sources.baseUrl ? [`baseUrl: ${r.sources.baseUrl}`] : []),
  ].join(', ');
  const installed = r.installed ? '' : ' [SDK not installed]';
  const baseUrlSuffix = r.baseUrl ? ` @ ${r.baseUrl}` : '';
  return `${phase.padEnd(16)}${r.provider} / ${r.model}${baseUrlSuffix}${installed}   (${sources})`;
}

export async function runRoutesCommand(opts: RoutesOptions): Promise<number> {
  let resolvedName = 'solo';
  let profileConfig: ProfileConfig | undefined;
  try {
    const resolved = resolveProfile({
      cwd: opts.cwd,
      ...(opts.flagProfile !== undefined ? { flagProfile: opts.flagProfile } : {}),
    });
    resolvedName = resolved.name;
    profileConfig = resolved.config;
    console.log(`Profile: ${resolved.name} (source: ${resolved.source})`);
  } catch (err) {
    console.error(`[cadence routes] profile resolution failed: ${(err as Error).message}`);
    return 1;
  }
  console.log('');
  console.log(`${'implement'.padEnd(16)}runtime-bound (Claude Code session model)`);
  let errCount = 0;
  for (const phase of ROUTED_PHASES as readonly PhaseName[]) {
    try {
      const route = resolvePhaseRoute(phase, profileConfig);
      console.log(fmt(phase, route));
    } catch (err) {
      console.log(`${phase.padEnd(16)}<unresolved: ${(err as Error).message}>`);
      errCount += 1;
    }
  }
  void resolvedName;
  return errCount === 0 ? 0 : 1;
}
