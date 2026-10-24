import type { CalendarAuthorizationStatus } from './calendar-service.ts'

/**
 * The calendar capability's shapes and the permission policy. The reads are
 * `CalendarService`.
 */

export {
  calendarAttendeeSchema,
  calendarAuthorizationStatusSchema,
  calendarEventSchema,
  calendarInfoSchema,
  type CalendarAttendee,
  type CalendarAuthorizationStatus,
  type CalendarEvent,
  type CalendarInfo,
} from './calendar-service.ts'

/** True when events can actually be read under `status`. */
export function canReadCalendars(status: CalendarAuthorizationStatus): boolean {
  return status === 'fullAccess'
}
