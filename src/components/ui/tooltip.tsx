
import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Claude Code desktop's tooltip: radius 6, 8×6, 13/18 text, max 240 px, a dark chip (#303030 in
          // dark mode), 120 ms fade + scale 0.98 in. No exit animation: WebKitGTK repainted the fading
          // tooltip in flashes
          "z-50 inline-flex w-fit max-w-60 items-center gap-1.5 rounded-[6px] bg-[#0b0b0b] px-2 py-1.5 text-[13px] leading-[18px] text-white shadow-[0_1px_2px_rgb(11_11_11/0.06),0_2px_8px_rgb(11_11_11/0.08)] dark:bg-[#303030] dark:text-[color:var(--cc-fg)] dark:shadow-[var(--cc-shadow-panel)] has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-98 data-[state=delayed-open]:duration-120 motion-reduce:animate-none [:root[data-reduce-motion]_&]:animate-none",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
