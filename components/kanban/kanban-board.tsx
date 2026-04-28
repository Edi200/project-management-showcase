'use client'

import {
  closestCorners,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import { updateIssueStatus } from '@/lib/actions/issue'
import { createClient } from '@/lib/client'
import { ISSUE_STATUSES, ISSUE_STATUS_LABELS, type IssueStatus } from '@/lib/issues/constants'
import { KanbanColumn } from '@/components/kanban/kanban-column'
import type { IssuesByStatus, KanbanIssue, KanbanMember } from '@/components/kanban/types'
import type { Database } from '@/types/database'
import { PriorityBadge } from '@/components/issues/priority-badge'
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from '@/components/ui/avatar'

type KanbanBoardProps = {
  issuesByStatus: IssuesByStatus
  projectId: string
  workspaceSlug: string
  members: KanbanMember[]
}

function cloneIssuesByStatus(source: IssuesByStatus): IssuesByStatus {
  return {
    todo: [...source.todo],
    in_progress: [...source.in_progress],
    in_review: [...source.in_review],
    done: [...source.done],
  }
}

function getInitials(name: string | null): string {
  if (!name || !name.trim()) {
    return 'U'
  }

  const parts = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return parts || 'U'
}

function findIssueById(state: IssuesByStatus, issueId: string): { issue: KanbanIssue; status: IssueStatus } | null {
  for (const status of ISSUE_STATUSES) {
    const issue = state[status].find((item) => item.id === issueId)
    if (issue) {
      return { issue, status }
    }
  }

  return null
}

function resolveDestinationStatus(state: IssuesByStatus, overId: string): IssueStatus | null {
  if (ISSUE_STATUSES.includes(overId as IssueStatus)) {
    return overId as IssueStatus
  }

  const overIssue = findIssueById(state, overId)
  return overIssue?.status ?? null
}

function isIssueStatus(value: string): value is IssueStatus {
  return ISSUE_STATUSES.includes(value as IssueStatus)
}

function removeIssueById(state: IssuesByStatus, issueId: string): IssuesByStatus {
  return {
    todo: state.todo.filter((issue) => issue.id !== issueId),
    in_progress: state.in_progress.filter((issue) => issue.id !== issueId),
    in_review: state.in_review.filter((issue) => issue.id !== issueId),
    done: state.done.filter((issue) => issue.id !== issueId),
  }
}

function upsertIssue(state: IssuesByStatus, issue: KanbanIssue): IssuesByStatus {
  const stateWithoutIssue = removeIssueById(state, issue.id)
  return {
    ...stateWithoutIssue,
    [issue.status]: [issue, ...stateWithoutIssue[issue.status]],
  }
}

function toKanbanIssue(
  row: Database['public']['Tables']['issues']['Row'],
  existing: KanbanIssue | null,
  isActiveDragIssue: boolean
): KanbanIssue | null {
  if (!isIssueStatus(row.status)) {
    return null
  }

  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    priority: row.priority as KanbanIssue['priority'],
    due_date: row.due_date,
    // Keep local status while dragging to avoid jumpy UI from concurrent realtime updates.
    status: isActiveDragIssue ? (existing?.status ?? row.status) : row.status,
    assignee_ids: existing?.assignee_ids ?? [],
    assignees: existing?.assignees ?? [],
  }
}

function DragPreviewCard({ issue }: { issue: KanbanIssue }) {
  return (
    <div className="w-[280px] rounded-md border bg-card p-3 shadow-lg">
      <p className="truncate font-medium">{issue.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PriorityBadge priority={issue.priority} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        {issue.assignees.length > 0 ? (
          <AvatarGroup>
            {issue.assignees.slice(0, 3).map((assignee) => (
              <Avatar key={assignee.user_id} size="sm">
                <AvatarImage alt={assignee.full_name ?? 'Assignee avatar'} src={assignee.avatar_url ?? undefined} />
                <AvatarFallback>{getInitials(assignee.full_name)}</AvatarFallback>
              </Avatar>
            ))}
            {issue.assignees.length > 3 ? (
              <AvatarGroupCount>+{issue.assignees.length - 3}</AvatarGroupCount>
            ) : null}
          </AvatarGroup>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
      </div>
    </div>
  )
}

export function KanbanBoard({ issuesByStatus, projectId, workspaceSlug, members }: KanbanBoardProps) {
  const router = useRouter()
  const [isMounted, setIsMounted] = useState(false)
  const [boardState, setBoardState] = useState<IssuesByStatus>(cloneIssuesByStatus(issuesByStatus))
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rollbackSnapshotRef = useRef<IssuesByStatus | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    })
  )

  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    setBoardState(cloneIssuesByStatus(issuesByStatus))
  }, [issuesByStatus])

  useEffect(() => {
    const supabase = createClient()
    const issuesChannel = supabase
      .channel(`kanban-issues-${projectId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'issues',
          filter: `project_id=eq.${projectId}`,
        },
        (payload: RealtimePostgresChangesPayload<Database['public']['Tables']['issues']['Row']>) => {
          if (payload.eventType === 'DELETE') {
            const oldIssueId = payload.old.id
            if (!oldIssueId) {
              return
            }
            setBoardState((prev) => removeIssueById(prev, oldIssueId))
            return
          }

          if (payload.eventType === 'INSERT') {
            if (!payload.new.id) {
              return
            }
            const insertedIssue = toKanbanIssue(payload.new, null, false)
            if (!insertedIssue) {
              return
            }
            setBoardState((prev) => upsertIssue(prev, insertedIssue))
            return
          }

          if (payload.eventType === 'UPDATE') {
            if (!payload.new.id) {
              return
            }
            setBoardState((prev) => {
              const existing = findIssueById(prev, payload.new.id)?.issue ?? null
              const updatedIssue = toKanbanIssue(payload.new, existing, activeIssueId === payload.new.id)
              if (!updatedIssue) {
                return prev
              }
              return upsertIssue(prev, updatedIssue)
            })
          }
        }
      )
      .subscribe()

    const issueAssigneesChannel = supabase
      .channel(`kanban-issue-assignees-${projectId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'issue_assignees',
        },
        () => {
          router.refresh()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(issuesChannel)
      supabase.removeChannel(issueAssigneesChannel)
    }
  }, [activeIssueId, projectId, router])

  const activeIssue = useMemo(() => {
    if (!activeIssueId) {
      return null
    }

    return findIssueById(boardState, activeIssueId)?.issue ?? null
  }, [activeIssueId, boardState])

  function handleDragStart(event: DragStartEvent) {
    setError(null)
    setActiveIssueId(String(event.active.id))
  }

  async function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    setActiveIssueId(null)

    if (!overId) {
      return
    }

    const source = findIssueById(boardState, activeId)
    if (!source) {
      return
    }

    const destinationStatus = resolveDestinationStatus(boardState, overId)
    if (!destinationStatus || destinationStatus === source.status) {
      return
    }

    const snapshot = cloneIssuesByStatus(boardState)
    rollbackSnapshotRef.current = snapshot

    const movedIssue: KanbanIssue = {
      ...source.issue,
      status: destinationStatus,
    }

    const optimisticState: IssuesByStatus = {
      ...snapshot,
      [source.status]: snapshot[source.status].filter((issue) => issue.id !== source.issue.id),
      [destinationStatus]: [movedIssue, ...snapshot[destinationStatus]],
    }

    setBoardState(optimisticState)

    const result = await updateIssueStatus(source.issue.id, destinationStatus, workspaceSlug, projectId)
    if ('error' in result) {
      setBoardState(rollbackSnapshotRef.current ?? snapshot)
      setError('Could not update issue status. Changes were reverted.')
    }
  }

  if (!isMounted) {
    return (
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-4">
          {ISSUE_STATUSES.map((status) => (
            <div key={status} className="min-w-[280px] rounded-md border bg-card p-3">
              <div className="h-5 w-28 animate-pulse rounded bg-muted" />
              <div className="mt-3 space-y-2">
                <div className="h-20 animate-pulse rounded bg-muted" />
                <div className="h-20 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <DndContext
        collisionDetection={closestCorners}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-max gap-4">
            {ISSUE_STATUSES.map((status) => (
              <SortableContext
                key={status}
                items={boardState[status].map((issue) => issue.id)}
                strategy={verticalListSortingStrategy}
              >
                <KanbanColumn
                  status={status}
                  label={ISSUE_STATUS_LABELS[status]}
                  issues={boardState[status]}
                  members={members}
                  workspaceSlug={workspaceSlug}
                />
              </SortableContext>
            ))}
          </div>
        </div>

        <DragOverlay>{activeIssue ? <DragPreviewCard issue={activeIssue} /> : null}</DragOverlay>
      </DndContext>
    </div>
  )
}
