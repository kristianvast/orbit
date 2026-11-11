import type { SVGProps } from "react";

export interface BrandMarkProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

export function BrandMark({ size = 22, className, ...rest }: BrandMarkProps) {
  return (
    <svg
      className={className ?? "orbit-brand__mark"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <rect
        x="6.2"
        y="3"
        width="11.6"
        height="18"
        rx="5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
      />
      <g transform="rotate(-28 12 12)">
        <path
          d="M 2 12 A 10 3.5 0 0 0 22 12"
          fill="none"
          stroke="var(--accent-primary)"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </g>
      <circle cx="20.4" cy="7.6" r="2.3" fill="var(--accent-primary)" />
    </svg>
  );
}
