import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// shadcn/ui button (MIT), retuned for IDE density (UI_PLAN §2.4):
// 28px default, 24px sm, 20px xs; 4px radius; 1px focus ring.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-sm font-medium whitespace-nowrap outline-none select-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[#0588f0]",
        secondary:
          "border-line bg-elevated text-fg hover:border-line-strong hover:bg-hover aria-expanded:bg-hover",
        outline:
          "border-line bg-transparent text-fg hover:bg-hover aria-expanded:bg-hover",
        ghost:
          "text-fg-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg data-[active=true]:bg-selected data-[active=true]:text-fg",
        destructive:
          "border-st-error/40 bg-st-error-tint text-st-error-fg hover:border-st-error/70",
        perm: "border-st-perm/50 bg-st-perm-tint text-st-perm-fg hover:border-st-perm/80",
        link: "h-auto border-0 px-0 text-link hover:underline",
      },
      size: {
        default: "h-7 gap-1.5 px-2.5",
        sm: "h-6 gap-1 px-2 text-xs",
        xs: "h-5 gap-1 px-1.5 text-2xs [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1.5 px-3",
        icon: "size-7",
        "icon-sm": "size-6",
        "icon-xs": "size-5 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "secondary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
