import * as React from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { chordLabel, effectiveKey, useCommands } from "@/commandRegistry"
import { useKeybindingOverrides } from "@/keybindings.store"
import { isMacPlatform } from "@/terminalKeys"

/** Touch hold before the tooltip opens (touch has no hover; the /m PWA relies on this). */
export const LONG_PRESS_MS = 500

/** Display label of `commandId`'s effective keybinding (user override over default), if bound. */
export function useCommandShortcut(commandId: string | undefined): string | undefined {
  const commands = useCommands()
  const overrides = useKeybindingOverrides()
  const cmd = commandId ? commands.find((c) => c.id === commandId) : undefined
  const key = cmd && effectiveKey(cmd, overrides)
  return key ? chordLabel(key, isMacPlatform()) : undefined
}

export interface IconTooltipProps {
  /** Tooltip text; for IconButton also the accessible name. */
  label: string
  /** Literal shortcut text; `commandId` wins when both resolve. */
  shortcut?: string
  /** ⌘K registry command whose keybinding is shown, so the tooltip never drifts from the binding. */
  commandId?: string
  side?: React.ComponentProps<typeof TooltipContent>["side"]
  disabled?: boolean
  /** Appended to the tooltip while `disabled`, e.g. "Nothing to undo". */
  disabledReason?: string
  /** Single element: the trigger (receives ref and event handlers). */
  children: React.ReactElement
}

/**
 * VS Code-style hover hint around one trigger: hover (after the provider delay) or focus opens
 * it, a touch long-press opens it too. A disabled trigger is wrapped in a focusable span, since
 * disabled buttons fire no pointer events (shadcn "Disabled Button" pattern).
 */
export function IconTooltip({ label, shortcut, commandId, side, disabled, disabledReason, children }: IconTooltipProps) {
  const fromRegistry = useCommandShortcut(commandId)
  const keys = fromRegistry ?? shortcut
  const [open, setOpen] = React.useState(false)
  const timer = React.useRef<number | undefined>(undefined)
  const longPressed = React.useRef(false)
  const cancel = () => window.clearTimeout(timer.current)
  React.useEffect(() => cancel, [])

  const trigger = disabled ? (
    <span tabIndex={0} data-slot="icon-tooltip-disabled" className="inline-flex [&>*]:pointer-events-none">
      {children}
    </span>
  ) : children

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        onPointerDown={(e) => {
          if (e.pointerType !== "touch") return
          longPressed.current = false
          cancel()
          timer.current = window.setTimeout(() => {
            longPressed.current = true
            setOpen(true)
          }, LONG_PRESS_MS)
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        // The release after a long-press is a hint request, not a click: swallow it before the button sees it.
        onClickCapture={(e) => {
          if (!longPressed.current) return
          longPressed.current = false
          e.preventDefault()
          e.stopPropagation()
        }}
        onContextMenu={(e) => { if (longPressed.current) e.preventDefault() }}
      >
        {trigger}
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {disabled && disabledReason ? ` (${disabledReason})` : null}
        {keys ? <> <kbd data-slot="tooltip-shortcut" className="ml-2 font-[inherit] opacity-70">{keys}</kbd></> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "aria-label" | "title"> &
  Omit<IconTooltipProps, "children" | "disabled"> & {
    /** Longer tooltip than `label`, for toggles: a stable name plus "state: click to …" text. */
    tooltip?: string
  }

/** Icon-only button: `label` is its accessible name and (unless `tooltip`) its tooltip. */
export function IconButton({ label, tooltip, shortcut, commandId, side, disabledReason, variant = "ghost", size = "icon", ...props }: IconButtonProps) {
  return (
    <IconTooltip label={tooltip ?? label} shortcut={shortcut} commandId={commandId} side={side} disabled={props.disabled ?? false} disabledReason={disabledReason}>
      <Button data-slot="icon-button" aria-label={label} variant={variant} size={size} {...props} />
    </IconTooltip>
  )
}
