'use server'

import { createServerClient } from '@supabase/ssr'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/server'
import type { Database } from '@/types/database'

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 50
const MAX_WORKSPACE_NAME_LENGTH = 100

type CreateWorkspaceResult =
  | { success: true; slug: string }
  | { error: string }

type RegenerateInviteTokenResult =
  | { success: true; newToken: string }
  | { error: string }

type UpdateWorkspaceInput = {
  name?: string
  slug?: string
}

type UpdateWorkspaceResult =
  | { success: true; newSlug?: string }
  | { error: string }

type DeleteWorkspaceResult = { success: true } | { error: string }

function normalizeName(value: string): string {
  return value.trim()
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase()
}

function validateWorkspaceInput(name: string, slug: string): string | null {
  if (!name) {
    return 'Workspace name is required.'
  }

  if (!slug) {
    return 'Slug is required.'
  }

  if (slug.length > MAX_SLUG_LENGTH) {
    return `Slug must be ${MAX_SLUG_LENGTH} characters or fewer.`
  }

  if (!SLUG_PATTERN.test(slug)) {
    return 'Slug must use lowercase letters, numbers, and hyphens only.'
  }

  return null
}

export async function createWorkspace(
  nameInput: string,
  slugInput: string
): Promise<CreateWorkspaceResult> {
  try {
    const name = normalizeName(nameInput)
    const slug = normalizeSlug(slugInput)
    const validationError = validateWorkspaceInput(name, slug)

    if (validationError) {
      return { error: validationError }
    }

    const cookieStore = await cookies()
    const cookieOptions = {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
        cookiesToSet.forEach(({ name, value, options }) => {
          try {
            cookieStore.set(name, value, options)
          } catch {
            // ignore
          }
        })
      },
    }

    const sessionSupabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { cookies: cookieOptions }
    )

    const {
      data: { session },
    } = await sessionSupabase.auth.getSession()

    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: cookieOptions,
        global: {
          headers: session?.access_token
            ? {
                Authorization: `Bearer ${session.access_token}`,
              }
            : {},
        },
      }
    )

    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
    const userId = claimsData?.claims?.sub ?? null

    if (claimsError || !userId) {
      return { error: 'You must be signed in to create a workspace.' }
    }

    const { data: existingWorkspace, error: existingWorkspaceError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()

    if (existingWorkspaceError) {
      return { error: 'Unable to validate workspace slug right now.' }
    }

    if (existingWorkspace) {
      return { error: 'This slug is already taken. Please choose another one.' }
    }

    const { data: workspace, error: workspaceInsertError } = await supabase
      .from('workspaces')
      .insert({
        name,
        slug,
        owner_id: userId,
      })
      .select('id, slug')
      .single()

    if (workspaceInsertError || !workspace) {
      const isUniqueViolation = workspaceInsertError?.code === '23505'
      if (isUniqueViolation) {
        return { error: 'This slug is already taken. Please choose another one.' }
      }

      return { error: 'Unable to create workspace right now.' }
    }

    const { error: membershipInsertError } = await supabase.from('workspace_members').insert({
      workspace_id: workspace.id,
      user_id: userId,
      role: 'owner',
    })

    if (membershipInsertError) {
      await supabase.from('workspaces').delete().eq('id', workspace.id)
      return { error: 'Workspace created partially. Please try again.' }
    }

    revalidatePath('/workspaces')
    revalidatePath(`/${workspace.slug}`)

    return { success: true, slug: workspace.slug }
  } catch {
    return { error: 'Unable to create workspace right now.' }
  }
}

export async function regenerateInviteToken(
  workspaceId: string,
  workspaceSlug: string
): Promise<RegenerateInviteTokenResult> {
  try {
    if (!workspaceId) {
      return { error: 'Workspace id is required.' }
    }

    const supabase = await createClient()
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
    const userId = claimsData?.claims?.sub ?? null

    if (claimsError || !userId) {
      return { error: 'You must be signed in to regenerate the invite link.' }
    }

    const { data: membership, error: membershipError } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (membershipError || !membership) {
      return { error: 'Unable to verify workspace access.' }
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return { error: 'Only workspace owners or admins can regenerate invite links.' }
    }

    const { data: updatedWorkspace, error: updateError } = await supabase
      .from('workspaces')
      .update({ invite_token: crypto.randomUUID() })
      .eq('id', workspaceId)
      .select('invite_token')
      .single()

    if (updateError || !updatedWorkspace) {
      return { error: 'Unable to regenerate invite link right now.' }
    }

    revalidatePath(`/${workspaceSlug}/members`)

    return { success: true, newToken: updatedWorkspace.invite_token }
  } catch {
    return { error: 'Unable to regenerate invite link right now.' }
  }
}

export async function updateWorkspace(
  workspaceId: string,
  workspaceSlug: string,
  data: UpdateWorkspaceInput
): Promise<UpdateWorkspaceResult> {
  try {
    if (!workspaceId || !workspaceSlug) {
      return { error: 'Workspace information is required.' }
    }

    const supabase = await createClient()
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
    const userId = claimsData?.claims?.sub ?? null

    if (claimsError || !userId) {
      return { error: 'You must be signed in to update workspace settings.' }
    }

    const { data: membership, error: membershipError } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (membershipError || !membership) {
      return { error: 'Unable to verify workspace access.' }
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return { error: 'Only workspace owners or admins can update workspace settings.' }
    }

    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id, slug')
      .eq('id', workspaceId)
      .maybeSingle()

    if (workspaceError || !workspace) {
      return { error: 'Workspace not found.' }
    }

    const patch: { name?: string; slug?: string } = {}

    if (typeof data.name !== 'undefined') {
      const normalizedName = normalizeName(data.name)

      if (!normalizedName) {
        return { error: 'Workspace name is required.' }
      }

      if (normalizedName.length > MAX_WORKSPACE_NAME_LENGTH) {
        return { error: `Workspace name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.` }
      }

      patch.name = normalizedName
    }

    let nextSlug: string | null = null
    if (typeof data.slug !== 'undefined') {
      const normalizedSlug = normalizeSlug(data.slug)

      if (!normalizedSlug) {
        return { error: 'Slug is required.' }
      }

      if (normalizedSlug.length > MAX_SLUG_LENGTH) {
        return { error: `Slug must be ${MAX_SLUG_LENGTH} characters or fewer.` }
      }

      if (!SLUG_PATTERN.test(normalizedSlug)) {
        return { error: 'Slug must use lowercase letters, numbers, and hyphens only.' }
      }

      if (normalizedSlug !== workspace.slug) {
        const { data: existingWorkspace, error: existingWorkspaceError } = await supabase
          .from('workspaces')
          .select('id')
          .eq('slug', normalizedSlug)
          .maybeSingle()

        if (existingWorkspaceError) {
          return { error: 'Unable to validate workspace slug right now.' }
        }

        if (existingWorkspace && existingWorkspace.id !== workspaceId) {
          return { error: 'This slug is already taken. Please choose another one.' }
        }

        nextSlug = normalizedSlug
      }

      patch.slug = normalizedSlug
    }

    if (Object.keys(patch).length === 0) {
      return { error: 'No changes to save.' }
    }

    const { error: updateError } = await supabase.from('workspaces').update(patch).eq('id', workspaceId)

    if (updateError) {
      if (updateError.code === '23505') {
        return { error: 'This slug is already taken. Please choose another one.' }
      }

      return { error: 'Unable to update workspace right now.' }
    }

    revalidatePath(`/${workspaceSlug}/settings`)

    if (nextSlug && nextSlug !== workspaceSlug) {
      revalidatePath(`/${nextSlug}/settings`)
      redirect(`/${nextSlug}/settings`)
    }

    return { success: true, newSlug: nextSlug ?? undefined }
  } catch {
    return { error: 'Unable to update workspace right now.' }
  }
}

export async function deleteWorkspace(
  workspaceId: string,
  workspaceSlug: string
): Promise<DeleteWorkspaceResult> {
  try {
    if (!workspaceId || !workspaceSlug) {
      return { error: 'Workspace information is required.' }
    }

    const supabase = await createClient()
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
    const userId = claimsData?.claims?.sub ?? null

    if (claimsError || !userId) {
      return { error: 'You must be signed in to delete a workspace.' }
    }

    const { data: membership, error: membershipError } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (membershipError || !membership) {
      return { error: 'Unable to verify workspace access.' }
    }

    if (membership.role !== 'owner') {
      return { error: 'Only workspace owners can delete this workspace.' }
    }

    const { error: deleteError } = await supabase.from('workspaces').delete().eq('id', workspaceId)

    if (deleteError) {
      return { error: 'Unable to delete workspace right now.' }
    }

    revalidatePath(`/${workspaceSlug}/settings`)
    revalidatePath('/workspaces')
    redirect('/workspaces')

    return { success: true }
  } catch {
    return { error: 'Unable to delete workspace right now.' }
  }
}
