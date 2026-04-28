'use client'

import { CSS } from '@dnd-kit/utilities'
import { useSortable } from '@dnd-kit/sortable'
import { Trash2Icon } from 'lucide-react'
import { useMemo, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'

import type { KanbanIssue, KanbanMember } from '@/components/kanban/types'
import { EditIssueDialog } from '@/components/issues/edit-issue-dialog'
import { PriorityBadge } from '@/components/issues/priority-badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { deleteIssue } from '@/lib/actions/issue'
import { cn } from '@/lib/utils'

type KanbanCardProps = {
  issue: KanbanIssue
  workspaceSlug: string
  members: KanbanMember[]
}

function formatDueDate(dueDate: string | null): string {
  if (!dueDate) {
    return 'No due date'
  }

  const parsed = new Date(dueDate)
  if (Number.isNaN(parsed.getTime())) {
    return 'No due date'
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed)
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

export function KanbanCard({ issue, workspaceSlug, members }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.id,
    data: {
      type: 'issue',
      status: issue.status,
    },
  })
  const isClosingRef = useRef(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const dueDate = useMemo(() => formatDueDate(issue.due_date), [issue.due_date])

  function openEditDialog() {
    if (isClosingRef.current) {
      return
    }

    setIsEditOpen(true)
  }

  function handleDelete() {
    setError(null)

    startTransition(async () => {
      const result = await deleteIssue(issue.id, workspaceSlug, issue.project_id)
      if ('error' in result) {
        setError(result.error)
        toast.error('Failed to delete issue.')
        return
      }

      toast.success('Issue deleted.')
    })
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'group relative cursor-grab rounded-md border bg-card p-3 shadow-sm transition-all hover:bg-muted/30 hover:shadow-md active:cursor-grabbing',
        isDragging && 'opacity-50 shadow-lg'
      )}
      onClick={openEditDialog}
      {...attributes}
      {...listeners}
    >
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            aria-label="Delete issue"
            className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100"
            disabled={isPending}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete issue</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this issue.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={handleDelete} variant="destructive">
              {isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="min-w-0 space-y-2 text-left">
        <p className="truncate font-medium">{issue.title}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <PriorityBadge priority={issue.priority} />
          <span>{dueDate}</span>
        </div>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
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

      <EditIssueDialog
        issue={{
          id: issue.id,
          project_id: issue.project_id,
          title: issue.title,
          description: null,
          status: issue.status,
          priority: issue.priority,
          due_date: issue.due_date,
          assignee_ids: issue.assignee_ids,
        }}
        hideTrigger
        members={members}
        onOpenChange={(open) => {
          if (!open) {
            isClosingRef.current = true
            setTimeout(() => {
              isClosingRef.current = false
            }, 300)
          }
          setIsEditOpen(open)
        }}
        open={isEditOpen}
        workspaceSlug={workspaceSlug}
      />
    </div>
  )
}
