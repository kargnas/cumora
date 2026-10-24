/**
 * Which item a key picks in an open `Menu` (ui/primitives.tsx): a
 * one-character `shortcut`, matched without case. Nothing when the key comes
 * with Ctrl, Cmd or Alt, or types into a field that kept focus. No React here,
 * so tests call it directly.
 */
export function shortcutItem<T extends { shortcut?: string }>(
  items: readonly T[],
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: EventTarget | null },
): T | undefined {
  const t = e.target as { isContentEditable?: boolean; tagName?: string } | null
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return undefined
  if (t?.isContentEditable || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return undefined
  return items.find((x) => x.shortcut?.toLowerCase() === e.key.toLowerCase())
}
