import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

/** Sakelar on/off (role="switch") dengan token warna VS Code, pola sama dengan Checkbox. */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-4 w-8 shrink-0 cursor-default items-center rounded-full border border-(--vscode-checkbox-border) bg-(--vscode-checkbox-background) outline-none transition-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-(--vscode-focusBorder) data-[state=checked]:bg-(--vscode-button-background) disabled:pointer-events-none disabled:opacity-40",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3 translate-x-0.5 rounded-full bg-(--vscode-checkbox-foreground) transition-none data-[state=checked]:translate-x-[18px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
