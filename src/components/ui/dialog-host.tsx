import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConfirmStore, usePromptStore } from '@/stores/dialogStore'

function ConfirmHost() {
  const request = useConfirmStore((s) => s.request)
  const resolve = useConfirmStore((s) => s.resolve)
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => { if (!open) resolve(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title ?? ''}</AlertDialogTitle>
          {request?.description && (
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => resolve(false)}>
            {request?.cancelLabel ?? 'Cancel'}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => resolve(true)}
            className={request?.destructive === false ? '' : 'bg-destructive/10 text-destructive hover:bg-destructive/20'}
          >
            {request?.confirmLabel ?? 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function PromptHost() {
  const request = usePromptStore((s) => s.request)
  const resolve = usePromptStore((s) => s.resolve)

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) resolve(null) }}>
      <DialogContent className="sm:max-w-md">
        {request && <PromptForm key={`${request.title}-${request.initialValue ?? ''}`} request={request} onSubmit={resolve} onCancel={() => resolve(null)} />}
      </DialogContent>
    </Dialog>
  )
}

function PromptForm({
  request,
  onSubmit,
  onCancel,
}: {
  request: NonNullable<ReturnType<typeof usePromptStore.getState>['request']>
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(request.initialValue ?? '')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const trimmed = value.trim()
    if (request.validate) {
      const err = request.validate(trimmed)
      if (err) {
        setError(err)
        return
      }
    }
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        {request.description && (
          <DialogDescription>{request.description}</DialogDescription>
        )}
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="prompt-dialog-input" className="sr-only">
          {request.title}
        </Label>
        <Input
          id="prompt-dialog-input"
          value={value}
          autoFocus
          placeholder={request.placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {request.cancelLabel ?? 'Cancel'}
        </Button>
        <Button onClick={submit} disabled={!value.trim()}>
          {request.confirmLabel ?? 'Save'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function DialogHost() {
  return (
    <>
      <ConfirmHost />
      <PromptHost />
    </>
  )
}
