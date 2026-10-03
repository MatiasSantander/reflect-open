import { useSessionStorageExternalStore } from '@/hooks/use-session-storage-external-store.ts'

/**
 * A string value persisted in sessionStorage and shared live across every
 * mounted subscriber of the same key — {@link useSessionFlag} without the
 * boolean, for settings that have more than two states.
 *
 * Null until something is stored, so the caller owns the default and a value
 * it no longer recognises can fall back rather than crash.
 */
export function useSessionValue(key: string): [string | null, (next: string) => void] {
  return useSessionStorageExternalStore(key)
}
