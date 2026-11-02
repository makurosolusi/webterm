// webterm chevron logo (40x40, purple gradient). One inline SVG is cheaper than an asset file.
// `gradientId` must be unique per screen: SVG ids are document-global.
export default function Brand({ gradientId, labelClassName = '' }: { gradientId: string; labelClassName?: string }) {
  return (
    <div className="flex items-center gap-3">
      <svg width={40} height={40} viewBox="0 0 48 48" aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a38dff" />
            <stop offset="1" stopColor="#622994" />
          </linearGradient>
        </defs>
        <path d="M13 12 L31 24 L13 36" fill="none" stroke={`url(#${gradientId})`} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={13} cy={12} r={3.6} fill="#a38dff" />
        <circle cx={13} cy={36} r={3.6} fill="#a38dff" />
        <circle cx={31} cy={24} r={3.6} fill="#fff" />
        <rect x={33.5} y={32.5} width={10.5} height={5} rx={2.5} fill="#a38dff" />
      </svg>
      <span className={`text-[30px] font-extrabold tracking-[-0.5px] ${labelClassName}`.trimEnd()}>webterm</span>
    </div>
  )
}
