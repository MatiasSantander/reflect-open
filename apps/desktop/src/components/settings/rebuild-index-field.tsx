import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { SettingsField } from './field.tsx'

/**
 * The recovery lever for the local index: a one-click full rebuild from the
 * markdown files (the same action as the palette's "Rebuild search index").
 * Progress and failures surface through the operations status UI. The local
 * in-flight state only drives the label and disabled treatment —
 * `rebuildVisibly` itself coalesces overlapping requests, including races
 * with the palette command.
 */
export function RebuildIndexField(): ReactElement {
  const { indexGeneration } = useGraph()
  const { indexLifecycle } = useCoreServices()
  const [rebuilding, setRebuilding] = useState(false)

  const rebuild = async (): Promise<void> => {
    if (rebuilding) {
      return
    }
    setRebuilding(true)
    try {
      await indexLifecycle.rebuildVisibly()
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <SettingsField
      legend="Rebuild index"
      description="Reflect keeps a local index of your notes to power search and links. If results ever look stale or incomplete, rebuild it — your notes are never changed."
    >
      <div className="mt-3 flex justify-start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={indexGeneration === null || rebuilding}
          onClick={() => void rebuild()}
          className="text-text-secondary"
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild index'}
        </Button>
      </div>
    </SettingsField>
  )
}
