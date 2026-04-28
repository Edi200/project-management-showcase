import Link from 'next/link'
import { redirect } from 'next/navigation'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/server'

type InvitePageProps = Readonly<{
  params: Promise<{ token: string }>
}>

function buildLoginRedirect(token: string): string {
  const loginParams = new URLSearchParams({ next: `/invite/${token}` })
  return `/login?${loginParams.toString()}`
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params
  const supabase = await createClient()

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims?.sub ?? null

  if (claimsError || !userId) {
    redirect(buildLoginRedirect(token))
  }

  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id, slug, name')
    .eq('invite_token', token)
    .maybeSingle()

  if (workspaceError) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Unable to process invite</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>
                We could not validate this invite link right now. Please try again.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (!workspace) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Invalid invite link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert variant="destructive">
              <AlertTitle>Invalid invite link</AlertTitle>
              <AlertDescription>
                This invite link is invalid or has been revoked. Ask a workspace admin for a new link.
              </AlertDescription>
            </Alert>
            <Link className="text-sm font-medium underline underline-offset-4" href="/workspaces">
              Go to workspaces
            </Link>
          </CardContent>
        </Card>
      </main>
    )
  }

  const { data: existingMembership, error: existingMembershipError } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId)
    .maybeSingle()

  if (existingMembershipError) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Unable to process invite</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>
                We could not verify your workspace membership right now. Please try again.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (existingMembership) {
    redirect(`/${workspace.slug}`)
  }

  const { error: insertMembershipError } = await supabase.from('workspace_members').insert({
    workspace_id: workspace.id,
    user_id: userId,
    role: 'member',
  })

  if (insertMembershipError) {
    // Unique conflict means membership was created in parallel; proceed as success.
    if (insertMembershipError.code === '23505') {
      redirect(`/${workspace.slug}`)
    }

    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Unable to join workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>Join failed</AlertTitle>
              <AlertDescription>
                We could not add you to {workspace.name}. Please contact a workspace admin.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </main>
    )
  }

  redirect(`/${workspace.slug}`)
}
