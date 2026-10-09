import { create } from 'zustand'
import { toast as sonner } from 'sonner'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

let nextId = 1

interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], message: string) => void
  dismiss: (id: number) => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) =>
    set((state) => {
      const id = nextId++
      const toast = { id, kind, message }
      // Auto-dismiss after 4.5s
      setTimeout(() => {
        useToastStore.getState().dismiss(id)
      }, 4500)
      return { toasts: [...state.toasts.slice(-3), toast] }
    }),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  success: (message: string) => sonner.success(message),
  error: (message: string) => sonner.error(message),
  info: (message: string) => sonner.info(message),
}
