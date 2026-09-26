import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-cyan text-navy-deep hover:bg-cyan-deep hover:text-white",
  secondary: "border border-mist bg-white text-navy hover:bg-paper",
  ghost: "text-navy hover:bg-mist",
  danger: "bg-danger text-white hover:bg-danger/90",
};

export function Button({ variant = "primary", type = "button", children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]}`}
      {...rest}
    >
      {children}
    </button>
  );
}
