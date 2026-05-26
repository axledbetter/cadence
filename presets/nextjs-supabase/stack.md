A Next.js 16 App Router application with:
- TypeScript, React 19, Tailwind CSS
- Supabase (Postgres + RLS on all tables)
- Jest/Vitest for unit tests, Playwright for E2E
- OpenAI/Anthropic for LLM calls
- Optional: Weaviate multi-tenant (every query must include .withTenant())

Conventions:
- DB mutations go through server-side service functions
- API routes under app/api/ return NextResponse.json
- Service role key is SERVER-ONLY; never imported in client components
- Every table has RLS; bypass via createServiceRoleClient() is server-only

Things that should flag CRITICAL:
- createServiceRoleClient() in client-side code
- Raw SQL in route handlers
- Missing rate limit on public POST endpoints
- Weaviate queries without .withTenant()
- Secrets committed to code
- RLS policy DROP without replacement

Frontend quality (optional layer — issue #178):
- Run `npm run audit:frontend` for a deterministic AST audit of `.tsx`/`.jsx`
  in the PR diff (raw color literals, missing alt, icon-only buttons without
  aria-label, interactive divs without keyboard support, unlabeled inputs).
- The matching impl-agent playbook lives at
  `skills/frontend-impl-playbook/SKILL.md`. Read it before writing UI.
