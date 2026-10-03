import type { ReactElement } from 'react'
import { CalendarRange } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { useSessionValue } from '@/lib/use-session-value.ts'

/**
 * How many days the Events section covers, chosen from a menu shaped like
 * the Tasks view's filters.
 *
 * Radio items, not checkboxes: the spans nest, so three independent toggles
 * would let the user ask for a state that cannot exist.
 */
export const EVENT_SPANS = [1, 3, 5] as const

export type EventSpan = (typeof EVENT_SPANS)[number]

const DEFAULT_SPAN: EventSpan = 3

const STORAGE_KEY = 'reflect.events.span'

/** The chosen span, shared live across every mounted sidebar, like the task filters. */
export function useEventSpan(): [EventSpan, (next: EventSpan) => void] {
  const [stored, setStored] = useSessionValue(STORAGE_KEY)
  const parsed = Number(stored)
  const span = EVENT_SPANS.find((candidate) => candidate === parsed) ?? DEFAULT_SPAN
  return [span, (next: EventSpan) => setStored(String(next))]
}

interface EventsSpanMenuProps {
  span: EventSpan
  onSpanChange: (next: EventSpan) => void
}

export function EventsSpanMenu({ span, onSpanChange }: EventsSpanMenuProps): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="text-xs font-normal text-text-muted">
            <CalendarRange aria-hidden className="size-3.5" />
            {span === 1 ? '1 day' : `${span} days`}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(span)}
            onValueChange={(value) => onSpanChange(Number(value) as EventSpan)}
          >
            {EVENT_SPANS.map((candidate) => (
              <DropdownMenuRadioItem key={candidate} value={String(candidate)}>
                {candidate === 1 ? '1 day' : `${candidate} days`}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
