/** Icônes SVG minimalistes (aucune dépendance), dessinées à la main. */
import type { ReactNode } from 'react';

export interface IconProps {
  readonly size?: number;
  readonly className?: string;
}

function svgProps(size: number, className: string): { width: number; height: number; className: string; viewBox: string; fill: string } {
  return { width: size, height: size, className, viewBox: '0 0 24 24', fill: 'none' };
}

function Svg({ size = 18, className = 'icon', children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg {...svgProps(size, className)} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function IconDashboard(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 13h6V4H4v9Z" />
      <path d="M14 20h6V11h-6v9Z" />
      <path d="M4 20h6v-3H4v3Z" />
      <path d="M14 7h6V4h-6v3Z" />
    </Svg>
  );
}

export function IconInvestments(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 17l5-6 4 3 5-7 4 4" />
      <path d="M3 21h18" />
    </Svg>
  );
}

export function IconCrypto(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 8.5h4a2 2 0 0 1 0 4h-4m0 0h4.5a2 2 0 0 1 0 4H9.5m0-8v8" />
    </Svg>
  );
}

export function IconRealEstate(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z" />
      <path d="M10 20v-6h4v6" />
    </Svg>
  );
}

export function IconCash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8h18v9H3z" />
      <circle cx="12" cy="12.5" r="2.4" />
      <path d="M6 8V6h12v2" />
    </Svg>
  );
}

export function IconTransactions(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </Svg>
  );
}

export function IconIncome(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </Svg>
  );
}

export function IconAnalytics(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20V9" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H3" />
    </Svg>
  );
}

export function IconConnections(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.5 6H15a3 3 0 0 1 3 3v6.5" />
      <path d="M6 8.5V15a3 3 0 0 0 3 3h6.5" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M4 12h2m12 0h2M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6 1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </Svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </Svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </Svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}
