import React from 'react'

export function Panel({
  children,
  className = '',
  accent,
}: {
  children: React.ReactNode
  className?: string
  accent?: string
}) {
  return (
    <div
      className={`rounded-xl border bg-[#0d1220] ${className}`}
      style={{ borderColor: accent || 'rgba(148,163,184,0.14)', borderTopColor: accent || undefined, borderTopWidth: accent ? 2 : 1 }}
    >
      {children}
    </div>
  )
}

export function Row({
  label,
  value,
  valueClass = 'text-slate-100',
}: {
  label: string
  value: React.ReactNode
  valueClass?: string
}) {
  return (
    <div className="flex items-center justify-between py-[7px] text-[13px] border-b border-white/5 last:border-0">
      <span className="text-slate-400">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass}`}>{value}</span>
    </div>
  )
}

export function Btn({
  children,
  onClick,
  variant = 'default',
  disabled,
  className = '',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'success' | 'warn'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  const styles: Record<string, string> = {
    default: 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-200 border border-white/10',
    ghost: 'bg-transparent hover:bg-white/5 text-slate-300 border border-white/10',
    primary: 'bg-violet-600 hover:bg-violet-500 text-white',
    success: 'bg-emerald-600 hover:bg-emerald-500 text-white',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white',
    warn: 'bg-transparent hover:bg-amber-500/10 text-amber-400 border border-amber-500/40',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
}

export function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-[12px] text-slate-400 mb-1.5">{label}</span>
      {children}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-violet-500/60 placeholder:text-slate-600 ${props.className || ''}`}
    />
  )
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-violet-500/60 ${props.className || ''}`}
    />
  )
}

export function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <h3 className="text-[13px] font-semibold text-slate-200 tracking-wide">{children}</h3>
      {sub && <span className="text-[11px] text-slate-500">{sub}</span>}
    </div>
  )
}
