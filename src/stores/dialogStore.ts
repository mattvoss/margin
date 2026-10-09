import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface ConfirmState {
  request: ConfirmOptions | null
  resolver: ((value: boolean) => void) | null
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  resolve: (value: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolver: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      get().resolver?.(false)
      set({ request: opts, resolver: resolve })
    }),
  resolve: (value) => {
    get().resolver?.(value)
    set({ request: null, resolver: null })
  },
}))

export const confirmDialog = (opts: ConfirmOptions) => useConfirmStore.getState().confirm(opts)

export interface PromptOptions {
  title: string
  description?: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  validate?: (value: string) => string | null
}

interface PromptState {
  request: PromptOptions | null
  resolver: ((value: string | null) => void) | null
  prompt: (opts: PromptOptions) => Promise<string | null>
  resolve: (value: string | null) => void
}

export const usePromptStore = create<PromptState>((set, get) => ({
  request: null,
  resolver: null,
  prompt: (opts) =>
    new Promise<string | null>((resolve) => {
      get().resolver?.(null)
      set({ request: opts, resolver: resolve })
    }),
  resolve: (value) => {
    get().resolver?.(value)
    set({ request: null, resolver: null })
  },
}))

export const promptDialog = (opts: PromptOptions) => usePromptStore.getState().prompt(opts)
