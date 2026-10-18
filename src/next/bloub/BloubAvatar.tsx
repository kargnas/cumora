import { memo, useEffect, useRef, type CSSProperties, type Ref } from 'react'
import { COLORS, type BotColor, type ColorId } from './engine/skins'
import { attach, drawStill, restyle } from './director'
import type { BloubLook } from './looks'
import { VIEW_BOX } from './view'

/** The colours offered. Ink follows the theme (cream in dark mode, see `.nx-ink`),
 *  so bloub's Cream would repeat it there and all but vanish on light surfaces. */
export const PALETTE = COLORS.filter((c): c is BotColor & { id: Exclude<ColorId, 'creme'> } => c.id !== 'creme')
const HEX = new Map<string, string>(PALETTE.map((c) => [c.id, c.hex]))

/** Props that colour a `.nx-ink` element. Ink, and any id outside the palette,
 *  is left to the stylesheet. */
export function inkProps(color: string): { 'data-ink'?: 'encre'; style?: CSSProperties } {
  const hex = color === 'encre' ? undefined : HEX.get(color)
  return hex ? { style: { color: hex } } : { 'data-ink': 'encre' }
}

function Svg({ look, size, svgRef }: { look: BloubLook; size: number; svgRef: Ref<SVGSVGElement> }) {
  // The director owns everything inside: React renders the empty svg once.
  return (
    <svg
      ref={svgRef}
      className="nx-bloub nx-ink"
      {...inkProps(look.color)}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      aria-hidden
    />
  )
}

/** An agent's live bloub: it plays what the agent is doing. */
export const BloubAvatar = memo(function BloubAvatar({ agentId, look, size, className }: {
  agentId: string
  look: BloubLook
  size: number
  className?: string
}) {
  const svg = useRef<SVGSVGElement>(null)
  const first = useRef(look)
  useEffect(() => {
    if (!svg.current) return
    return attach(agentId, svg.current, first.current)
  }, [agentId])
  useEffect(() => { restyle(agentId, look) }, [agentId, look])
  return (
    <span className={className ? `nx-avatar nx-avatar--bloub ${className}` : 'nx-avatar nx-avatar--bloub'} style={{ width: size, height: size }} aria-hidden>
      <Svg look={look} size={size} svgRef={svg} />
    </span>
  )
})

/** One resting frame of a look, for the picker. */
export function BloubStill({ look, size }: { look: BloubLook; size: number }) {
  const svg = useRef<SVGSVGElement>(null)
  const { shape, expression } = look
  useEffect(() => {
    if (!svg.current) return
    return drawStill(svg.current, shape, expression)
  }, [shape, expression])
  return <Svg look={look} size={size} svgRef={svg} />
}
