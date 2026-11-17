/** The exact text behind a summarized message (a store's raw response), collapsed by default. */
export function RawDetails({ text }: { text: string }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Raw details</summary>
      <pre className="mt-2 rounded-md border bg-muted/50 p-3 font-mono whitespace-pre-wrap break-all text-foreground">
        {text}
      </pre>
    </details>
  )
}
