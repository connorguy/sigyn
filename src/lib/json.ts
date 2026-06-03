import type { ImportEntryItem } from "./types"

export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const first = trimmed[0]
  if (first !== "{" && first !== "[") return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function parseJsonImport(text: string): {
  items: ImportEntryItem[]
  error: string | null
} {
  const trimmed = text.trim()
  if (!trimmed) return { items: [], error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { items: [], error: `Invalid JSON: ${(err as Error).message}` }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: [], error: "Expected a top-level JSON object of key/value pairs." }
  }

  const items: ImportEntryItem[] = []
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    let value: string
    if (raw === null) value = ""
    else if (typeof raw === "string") value = raw
    else if (typeof raw === "number" || typeof raw === "boolean") value = String(raw)
    else value = JSON.stringify(raw)
    items.push({ name, value })
  }

  return { items, error: null }
}
