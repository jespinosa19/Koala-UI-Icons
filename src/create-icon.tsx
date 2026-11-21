import { createElement } from "react"
import type { JSX, Ref, SVGProps } from "react"

export type IconNode = ReadonlyArray<readonly [tag: string, attrs: Readonly<Record<string, string | number>>]>

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  /** Width and height. A number is pixels; defaults to `1em` so the icon follows the font size. */
  size?: number | string
  /** Icon colour. Without it the icon uses `currentColor`, so `text-*` utilities colour it. */
  color?: string
  /** Accessible name. Without it (or `aria-label`) the icon is decorative and hidden from AT. */
  title?: string
  /**
   * Accepted so code migrated from Phosphor keeps compiling. The set has one weight, the outline,
   * so every value draws the same icon. There is no fill weight.
   */
  weight?: "regular" | "bold" | "light" | "thin" | "duotone"
  ref?: Ref<SVGSVGElement>
}

export type IconComponent = ((props: IconProps) => JSX.Element) & { displayName: string }

const draw = (node: IconNode) => node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))

/**
 * Turns a master's element list into a component. No context and no hooks, so every icon renders
 * in Server Components as-is. The stroke is set once on the root (SPEC.md §2); pass `strokeWidth`
 * only for a deliberate one-off, the set is drawn for 1.75.
 *
 * `small` is the optional small master (SPEC.md §12). Both drawings ship and `optical.css` shows
 * the one that fits the icon's rendered size; without that stylesheet the large one shows.
 */
export function createIcon(name: string, node: IconNode, small?: IconNode): IconComponent {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function Icon({ size = "1em", color, title, weight, children, ref, style, ...props }: IconProps) {
    const labelled = title != null || props["aria-label"] != null || props["aria-labelledby"] != null
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        // `color`, not `stroke`: the dot primitive is filled with currentColor and must follow too.
        style={color != null ? { ...style, color } : style}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={labelled ? undefined : true}
        role={labelled ? "img" : undefined}
        data-icon={name}
        {...props}
      >
        {title != null && <title>{title}</title>}
        {small ? (
          <>
            <g data-optical="large">{draw(node)}</g>
            <g data-optical="small" display="none" strokeWidth={2.25}>
              {draw(small)}
            </g>
          </>
        ) : (
          draw(node)
        )}
        {children}
      </svg>
    )
  }
  Icon.displayName = name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())
  return Icon
}
