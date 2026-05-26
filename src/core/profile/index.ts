/**
 * Public profile API.
 *
 * Re-exports `resolveProfile` and its companion types. `loadProfileByName`
 * is intentionally NOT re-exported (spec revised pass 3 CRITICAL #2) —
 * external consumers MUST go through `resolveProfile()` so they pick up
 * the full precedence chain (file → env → flag) and the path-safety gate
 * uniformly. Direct callers that need to bypass the chain (tests, internal
 * tooling) can import `_loadProfileByNameForTest` from `./resolver.ts`.
 */

export { resolveProfile } from './resolver.ts';
export type { ResolveProfileOptions } from './resolver.ts';
export {
  ProfileResolutionError,
  type ProfileConfig,
  type CodexPassConfig,
  type ContributorPolicy,
  type ProfileResolutionSource,
  type ProfileResolutionErrorCode,
  type ResolvedProfile,
} from './types.ts';
