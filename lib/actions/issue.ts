'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/lib/server'
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueStatus,
} from '@/lib/issues/constants'

const GENERIC_ERROR = 'Unable to process request.'
const MAX_ISSUE_TITLE_LENGTH = 255

type IssueMutationResult = { success: true } | { error: string }
type CreateIssueResult = { success: true; issueId: string } | { error: string }

type CreateIssueInput = {
  title: string
  description?: string
  status: IssueStatus
  priority: IssuePriority
  due_date?: string | null
  assignee_ids?: string[]
}

type UpdateIssueInput = {
  title?: string
  description?: string | null
  status?: IssueStatus
  priority?: IssuePriority
  due_date?: string | null
  assignee_ids?: string[]
}

function isIssueStatus(value: string): value is IssueStatus {
  return ISSUE_STATUSES.includes(value as IssueStatus)
}

function isIssuePriority(value: string): value is IssuePriority {
  return ISSUE_PRIORITIES.includes(value as IssuePriority)
}

function normalizeDueDate(value: string | null | undefined): string | null | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return undefined
  }

  return trimmed
}

async function getAuthorizedUserId() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()

  if (error) {
    return { supabase, userId: null as string | null }
  }

  return { supabase, userId: data?.claims?.sub ?? null }
}

async function getWorkspaceIdBySlug(
  slug: string,
  supabase: Awaited<ReturnType<typeof createClient>>
) {
  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()

  if (error || !workspace) {
    return null
  }

  return workspace.id
}

function revalidateIssuePaths(workspaceSlug: string, projectId: string) {
  revalidatePath(`/${workspaceSlug}/projects/${projectId}`)
  revalidatePath(`/${workspaceSlug}/issues`)
}

async function syncIssueAssignees(
  issueId: string,
  workspaceId: string,
  assigneeIds: string[],
  supabase: Awaited<ReturnType<typeof createClient>>
) {
  const uniqueAssigneeIds = Array.from(new Set(assigneeIds))

  const { error: deleteError } = await supabase
    .from('issue_assignees')
    .delete()
    .eq('issue_id', issueId)

  if (deleteError) {
    return { error: true }
  }

  if (uniqueAssigneeIds.length === 0) {
    return { error: false }
  }

  const { data: members, error: membersError } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .in('user_id', uniqueAssigneeIds)

  if (membersError) {
    return { error: true }
  }

  const allowedIds = new Set((members ?? []).map((member) => member.user_id))
  const filteredAssigneeIds = uniqueAssigneeIds.filter((userId) => allowedIds.has(userId))

  if (filteredAssigneeIds.length === 0) {
    return { error: false }
  }

  const payload = filteredAssigneeIds.map((userId) => ({
    issue_id: issueId,
    user_id: userId,
  }))

  const { error: insertError } = await supabase.from('issue_assignees').insert(payload)
  return { error: Boolean(insertError) }
}

export async function createIssue(
  projectId: string,
  workspaceSlug: string,
  data: CreateIssueInput
): Promise<CreateIssueResult> {
  try {
    const { supabase, userId } = await getAuthorizedUserId()
    if (!userId) {
      return { error: GENERIC_ERROR }
    }

    const title = data.title.trim()
    if (!title || title.length > MAX_ISSUE_TITLE_LENGTH) {
      return { error: GENERIC_ERROR }
    }

    if (!isIssueStatus(data.status) || !isIssuePriority(data.priority)) {
      return { error: GENERIC_ERROR }
    }

    const dueDate = normalizeDueDate(data.due_date)
    if (typeof data.due_date !== 'undefined' && typeof dueDate === 'undefined') {
      return { error: GENERIC_ERROR }
    }

    const workspaceId = await getWorkspaceIdBySlug(workspaceSlug, supabase)
    if (!workspaceId) {
      return { error: GENERIC_ERROR }
    }

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, workspace_id')
      .eq('id', projectId)
      .maybeSingle()

    if (projectError || !project || project.workspace_id !== workspaceId) {
      return { error: GENERIC_ERROR }
    }

    const { data: issue, error: issueError } = await supabase
      .from('issues')
      .insert({
        project_id: project.id,
        created_by: userId,
        title,
        description: data.description?.trim() ? data.description.trim() : null,
        status: data.status,
        priority: data.priority,
        due_date: dueDate ?? null,
      })
      .select('id')
      .single()

    if (issueError || !issue) {
      return { error: GENERIC_ERROR }
    }

    if (Array.isArray(data.assignee_ids) && data.assignee_ids.length > 0) {
      const syncResult = await syncIssueAssignees(issue.id, workspaceId, data.assignee_ids, supabase)
      if (syncResult.error) {
        return { error: GENERIC_ERROR }
      }
    }

    revalidateIssuePaths(workspaceSlug, project.id)
    return { success: true, issueId: issue.id }
  } catch {
    return { error: GENERIC_ERROR }
  }
}

export async function updateIssue(
  issueId: string,
  workspaceSlug: string,
  data: UpdateIssueInput
): Promise<IssueMutationResult> {
  try {
    const { supabase, userId } = await getAuthorizedUserId()
    if (!userId) {
      return { error: GENERIC_ERROR }
    }

    const workspaceId = await getWorkspaceIdBySlug(workspaceSlug, supabase)
    if (!workspaceId) {
      return { error: GENERIC_ERROR }
    }

    const { data: issue, error: issueError } = await supabase
      .from('issues')
      .select('id, project_id, projects!inner(workspace_id)')
      .eq('id', issueId)
      .maybeSingle()

    if (issueError || !issue || issue.projects.workspace_id !== workspaceId) {
      return { error: GENERIC_ERROR }
    }

    const patch: {
      title?: string
      description?: string | null
      status?: IssueStatus
      priority?: IssuePriority
      due_date?: string | null
    } = {}

    if (typeof data.title !== 'undefined') {
      const title = data.title.trim()
      if (!title || title.length > MAX_ISSUE_TITLE_LENGTH) {
        return { error: GENERIC_ERROR }
      }
      patch.title = title
    }

    if (typeof data.description !== 'undefined') {
      patch.description = data.description?.trim() ? data.description.trim() : null
    }

    if (typeof data.status !== 'undefined') {
      if (!isIssueStatus(data.status)) {
        return { error: GENERIC_ERROR }
      }
      patch.status = data.status
    }

    if (typeof data.priority !== 'undefined') {
      if (!isIssuePriority(data.priority)) {
        return { error: GENERIC_ERROR }
      }
      patch.priority = data.priority
    }

    if (typeof data.due_date !== 'undefined') {
      const dueDate = normalizeDueDate(data.due_date)
      if (typeof dueDate === 'undefined') {
        return { error: GENERIC_ERROR }
      }
      patch.due_date = dueDate
    }

    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await supabase.from('issues').update(patch).eq('id', issueId)
      if (updateError) {
        return { error: GENERIC_ERROR }
      }
    }

    if (typeof data.assignee_ids !== 'undefined') {
      const syncResult = await syncIssueAssignees(issueId, workspaceId, data.assignee_ids, supabase)
      if (syncResult.error) {
        return { error: GENERIC_ERROR }
      }
    }

    revalidateIssuePaths(workspaceSlug, issue.project_id)
    return { success: true }
  } catch {
    return { error: GENERIC_ERROR }
  }
}

export async function deleteIssue(
  issueId: string,
  workspaceSlug: string,
  projectId: string
): Promise<IssueMutationResult> {
  try {
    const { supabase, userId } = await getAuthorizedUserId()
    if (!userId) {
      return { error: GENERIC_ERROR }
    }

    const workspaceId = await getWorkspaceIdBySlug(workspaceSlug, supabase)
    if (!workspaceId) {
      return { error: GENERIC_ERROR }
    }

    const { data: issue, error: issueError } = await supabase
      .from('issues')
      .select('id, project_id, projects!inner(workspace_id)')
      .eq('id', issueId)
      .maybeSingle()

    if (
      issueError ||
      !issue ||
      issue.project_id !== projectId ||
      issue.projects.workspace_id !== workspaceId
    ) {
      return { error: GENERIC_ERROR }
    }

    const { error: deleteError } = await supabase.from('issues').delete().eq('id', issueId)
    if (deleteError) {
      return { error: GENERIC_ERROR }
    }

    revalidateIssuePaths(workspaceSlug, projectId)
    return { success: true }
  } catch {
    return { error: GENERIC_ERROR }
  }
}

export async function updateIssueStatus(
  issueId: string,
  status: IssueStatus,
  workspaceSlug: string,
  projectId: string
): Promise<IssueMutationResult> {
  try {
    const { supabase, userId } = await getAuthorizedUserId()
    if (!userId || !isIssueStatus(status)) {
      return { error: GENERIC_ERROR }
    }

    const workspaceId = await getWorkspaceIdBySlug(workspaceSlug, supabase)
    if (!workspaceId) {
      return { error: GENERIC_ERROR }
    }

    const { data: issue, error: issueError } = await supabase
      .from('issues')
      .select('id, project_id, projects!inner(workspace_id)')
      .eq('id', issueId)
      .maybeSingle()

    if (
      issueError ||
      !issue ||
      issue.project_id !== projectId ||
      issue.projects.workspace_id !== workspaceId
    ) {
      return { error: GENERIC_ERROR }
    }

    const { error: updateError } = await supabase
      .from('issues')
      .update({ status })
      .eq('id', issueId)

    if (updateError) {
      return { error: GENERIC_ERROR }
    }

    revalidateIssuePaths(workspaceSlug, projectId)
    return { success: true }
  } catch {
    return { error: GENERIC_ERROR }
  }
}
