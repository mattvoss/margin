import { createFileRoute } from '@tanstack/react-router'
import SimpleEditor from '../pages/SimpleEditor'
import { Toaster } from '../components/Toaster'
import { DialogHost } from '../components/ui/dialog-host'

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  return (
    <>
      <SimpleEditor />
      <Toaster />
      <DialogHost />
    </>
  )
}
