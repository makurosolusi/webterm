import * as React from "react"
import { cn } from "@/lib/utils"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { portalContainer } from "@/components/vscode/portalContainer"

// shadcn/ui new-york-v4 tooltip (registry commit c257f68, 2026-09-04), adapted:
// - VS Code hover timing: workbench.hover delay 500ms; moving to a neighbour within 300ms opens it at once.
// - VS Code hover look (editorHoverWidget colours, 12px/19px, 2px 8px padding, no arrow) instead of bg-foreground.
// - Portals into the fullscreen element when there is one (same rule as the vscode overlays).
// - Tooltip outside a provider gets its own one, so components render alone in tests and hosts.

/** VS Code `workbench.hover.delay`. */
export const TOOLTIP_DELAY_MS = 500
/** Window after a tooltip closes in which the next one opens without delay. */
export const TOOLTIP_SKIP_DELAY_MS = 300

const ProviderPresent = React.createContext(false)

/** Shared hover timing for every tooltip below it; mount once at the app root. */
function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  skipDelayDuration = TOOLTIP_SKIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <ProviderPresent.Provider value={true}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        {...props}
      />
    </ProviderPresent.Provider>
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  return React.useContext(ProviderPresent) ? root : <TooltipProvider>{root}</TooltipProvider>
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal container={portalContainer()}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[1400] w-fit max-w-[500px] origin-(--radix-tooltip-content-transform-origin) rounded-(--vscode-cornerRadius-large) border border-(--vscode-editorHoverWidget-border) bg-(--vscode-editorHoverWidget-background) px-2 py-0.5 text-(length:--ui-font-size) leading-[19px] text-(--vscode-editorHoverWidget-foreground) shadow-(--wt-shadow-floating)",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
