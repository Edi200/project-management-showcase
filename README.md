# Project Management App — Showcase

A collection of production code samples extracted from a real-world SaaS project management app built with Next.js 16, Supabase, TypeScript, and shadcn/ui.

## Samples

### Kanban Board with Real-time Subscriptions (`kanban-board.tsx`)
A fully client-side Kanban board with drag & drop and live updates via Supabase Realtime.

* Drag & drop across status columns using `@dnd-kit/core` and `@dnd-kit/sortable`
* Optimistic UI updates — card moves instantly, reverts on server error
* Real-time subscriptions via `supabase.channel()` for `issues` and `issue_assignees` tables
* INSERT/UPDATE/DELETE events handled with local state merge (preserves assignee data)
* `router.refresh()` triggered on assignee changes to rehydrate server components
* Mouse and touch sensor support with activation distance guard

### Row Level Security Policies (Supabase PostgreSQL)
Database-level authorization ensuring users only access their own workspace data.

* Helper functions (`is_workspace_member`, `is_workspace_admin_or_owner`) defined as `SECURITY DEFINER` to prevent recursive RLS evaluation
* Per-table policies for SELECT/INSERT/UPDATE/DELETE across 8 tables
* Invite flow policy: authenticated users can join a workspace via `invite_token` without prior membership
* Profile visibility scoped to shared workspace members only

### Server Actions with Supabase SSR (`lib/actions/issue.ts`)
Type-safe server mutations using Next.js Server Actions and Supabase SSR client.

* Cookie-based Supabase client via `@supabase/ssr` for authenticated server-side mutations
* `getClaims()` for JWT-based auth in Server Actions (never `getSession()`)
* Cross-tenant protection: workspace ownership verified before every mutation
* Optimistic status updates for Kanban with `updateIssueStatus`
* Full CRUD: `createIssue`, `updateIssue`, `deleteIssue`, `updateIssueStatus`
* Assignee replacement via delete+insert pattern on update

### Workspace Invite Flow (`app/invite/[token]/page.tsx`)
Server-rendered invite join page with auth redirect preservation.

* Unauthenticated users redirected to `/login?next=/invite/[token]`
* OAuth callback honors `next` param to return user to invite after Google login
* Duplicate membership race condition handled via Postgres unique constraint (`23505`)
* Token-based workspace lookup with RLS policy scoped to non-null `invite_token`

## Stack

* Next.js 16 (App Router, Server Components, Server Actions)
* Supabase (PostgreSQL, Auth, Realtime, Storage)
* TypeScript
* Tailwind CSS + shadcn/ui
* @dnd-kit (drag & drop)
* next-themes (dark/light mode)
* Sonner (toast notifications)
* Vercel (deployment)
