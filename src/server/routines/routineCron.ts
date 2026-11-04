// Five-field cron (minute hour day-of-month month day-of-week) in local time, pure (vitest-safe).
//
// Imitated: Orca `src/shared/automation-cron-occurrence.ts` (local-field matching, calendar-day
// steps so DST days are not assumed to be 24 h, and the Vixie rule: when both day fields are
// restricted a date matches if EITHER matches) and Claude Code Desktop scheduled tasks
// (code.claude.com/docs/en/desktop-scheduled-tasks: cron in the machine's local time zone).
// Supported per field: `*`, `n`, `a-b`, `*/s`, `a-b/s`, comma lists; day-of-week 0-7 (0 and 7 = Sunday).

export interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week']
/** How far forward `nextCronAfter` searches (covers Feb 29 schedules). */
const SCAN_DAYS = 5 * 366

function parseField(text: string, index: number): Set<number> {
  const [min, max] = FIELDS[index] as readonly [number, number]
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`invalid cron ${FIELD_NAMES[index]} field "${text}"`)
    const lo = m[1] === '*' ? min : Number(m[2])
    const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo
    const step = m[4] !== undefined ? Number(m[4]) : 1
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron ${FIELD_NAMES[index]} out of range in "${text}" (${min}-${max})`)
    for (let v = lo; v <= hi; v += step) out.add(index === 4 && v === 7 ? 0 : v)
  }
  return out
}

/** Parses a five-field expression; throws an Error naming the bad field. */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got ${parts.length}`)
  const sets = parts.map(parseField)
  return {
    minutes: sets[0]!, hours: sets[1]!, daysOfMonth: sets[2]!, months: sets[3]!, daysOfWeek: sets[4]!,
    domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*',
  }
}

/** Error text for an invalid expression, else null (validation at the API boundary). */
export function cronError(expr: string): string | null {
  try { parseCron(expr); return null } catch (err) { return err instanceof Error ? err.message : String(err) }
}

function dateMatches(rule: ParsedCron, d: Date): boolean {
  if (!rule.months.has(d.getMonth() + 1)) return false
  const dom = rule.daysOfMonth.has(d.getDate())
  const dow = rule.daysOfWeek.has(d.getDay())
  return rule.domRestricted && rule.dowRestricted ? dom || dow : dom && dow
}

const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b)

/** Every occurrence on the local calendar day of `day`, ascending (empty if the date does not match). */
function occurrencesOn(rule: ParsedCron, day: Date): number[] {
  if (!dateMatches(rule, day)) return []
  const out: number[] = []
  for (const h of sorted(rule.hours)) {
    for (const m of sorted(rule.minutes)) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0)
      // A spring-forward gap moves the wall clock; keep only times that really read h:m.
      if (t.getHours() === h && t.getMinutes() === m) out.push(t.getTime())
    }
  }
  return out
}

const dayStart = (t: number, deltaDays = 0): Date => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays)
}

/** First occurrence strictly after `after`, or null when none within ~5 years. */
export function nextCronAfter(expr: string, after: number): number | null {
  const rule = parseCron(expr)
  for (let i = 0; i < SCAN_DAYS; i += 1) {
    const hit = occurrencesOn(rule, dayStart(after, i)).find((t) => t > after)
    if (hit !== undefined) return hit
  }
  return null
}

/** Latest occurrence in `[notBefore, atOrBefore]`, or null when the window holds none. */
export function latestCronBetween(expr: string, notBefore: number, atOrBefore: number): number | null {
  const rule = parseCron(expr)
  for (let i = 0; ; i -= 1) {
    const day = dayStart(atOrBefore, i)
    if (day.getTime() + 86_400_000 * 2 < notBefore) return null
    const hits = occurrencesOn(rule, day).filter((t) => t >= notBefore && t <= atOrBefore)
    if (hits.length) return hits[hits.length - 1]!
  }
}
