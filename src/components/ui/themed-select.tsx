import { useState } from 'react'
import { Check } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

export interface ThemedOption {
  value: string
  label: string
  icon?: React.ReactNode
}

const contentTheme =
  'bg-[var(--bg-elevated)] border-[var(--border-subtle)] text-[var(--text)]'

export function ThemedSelect({
  value,
  onChange,
  options,
  className = '',
  disabled = false,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: ThemedOption[]
  className?: string
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select value={value} onValueChange={(v) => { if (v !== null) onChange(v) }} disabled={disabled}>
      <SelectTrigger className={cn('border-[var(--border-subtle)] text-[12px]', className)}>
        <SelectValue placeholder={placeholder}>
          {options.find((o) => o.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className={contentTheme}>
        {options.map((o) => (
          <SelectItem key={o.value || '__placeholder__'} value={o.value} className="text-[12px]">
            <span className="flex items-center gap-2 min-w-0">
              {o.icon}
              <span className="truncate">{o.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SearchableSelect({
  value,
  onChange,
  options,
  className = '',
  disabled = false,
  searchPlaceholder = 'Search...',
}: {
  value: string
  onChange: (value: string) => void
  options: ThemedOption[]
  className?: string
  disabled?: boolean
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className={cn(
              'flex items-center justify-between gap-2 w-full border border-[var(--border-subtle)] rounded-[8px] px-3 py-1.5 text-[12px] bg-transparent text-[var(--text)] outline-none transition-colors cursor-pointer hover:border-[var(--text-secondary)] disabled:opacity-60',
              className,
            )}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {selected?.icon}
              <span className="truncate">{selected?.label ?? value}</span>
            </span>
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={4} className={cn('p-0 w-[var(--anchor-width)] min-w-[200px]', contentTheme, className.includes('mt-') ? '' : '')}>
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>No matches</CommandEmpty>
            {options.map((o) => {
              const active = o.value === value
              return (
                <CommandItem
                  key={o.value || '__placeholder__'}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'text-[12px]',
                    active ? 'text-[var(--text-heading)] font-medium' : 'text-[var(--text-secondary)]',
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                  </span>
                  {active && <Check size={14} className="shrink-0 text-[var(--accent-brown)]" />}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Compact pill for editor surfaces (bubble, image controls). Uses a Popover
// (not Select) so picking never steals TipTap focus — the wrapper keeps the
// editor selection intact via mousedown prevention, mirroring the old
// freezeSelection behavior.
export function MinimalSelect({
  value,
  onChange,
  options,
  className = '',
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  options: ThemedOption[]
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)

  return (
    <div onMouseDown={(e) => e.preventDefault()} className={cn('shrink-0', className)}>
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverTrigger
          disabled={disabled}
          render={
            <button
              type="button"
              className="flex items-center gap-1 h-6 pl-1.5 pr-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] rounded-[5px] bg-transparent border-0 outline-none cursor-pointer disabled:opacity-60 w-full"
            >
              <span className="truncate">{selected?.label ?? value}</span>
              <svg className="w-3 h-3 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          }
        />
        <PopoverContent align="end" sideOffset={4} className={cn('p-1 w-max max-w-[240px] max-h-[160px] overflow-y-auto', contentTheme)}>
          {options.map((o) => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`w-full flex items-center justify-between gap-2 text-left rounded-[8px] transition-colors cursor-pointer px-2 py-1.5 text-[11px] ${active ? 'text-[var(--text-heading)] font-medium' : 'text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)]'}`}
              >
                <span className="truncate">{o.label}</span>
                {active && <Check size={14} className="shrink-0 text-[var(--accent-brown)]" />}
              </button>
            )
          })}
        </PopoverContent>
      </Popover>
    </div>
  )
}
