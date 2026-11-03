// Butir "Lokasi Chromium" di Lanjutan: server mencari sendiri (path aktif + kandidat di disk), pengguna
// boleh menimpa dengan path sendiri atau kembali ke otomatis.
import { useEffect, useState } from 'react'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ADVANCED_TEXT } from './advancedLabels'

const INPUT_ID = 'capabilities-chromium'

export interface ChromiumPathFieldProps {
  chromium: CapabilitiesResponse['advanced']['chromiumPath']
  /** Simpan override; '' = hapus override (pakai otomatis). */
  save(path: string): Promise<void>
  /** Muat ulang dari server; deteksi berjalan ulang di tiap GET. */
  redetect(): Promise<void>
}

/** Path aktif + sumbernya, kandidat untuk dipilih cepat, input override, dan kembali ke otomatis. */
export function ChromiumPathField({ chromium, save, redetect }: ChromiumPathFieldProps): React.JSX.Element {
  const [path, setPath] = useState(chromium.value)
  // Nilai server berubah (mis. setelah setel ulang): kolom ikut, bukan menyimpan draf basi.
  useEffect(() => setPath(chromium.value), [chromium.value])
  const auto = chromium.candidates[0]

  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2" data-field="chromium">
      <Label htmlFor={INPUT_ID}>{ADVANCED_TEXT.chromiumLabel}</Label>
      {/* Status di blok sendiri, leading normal, path panjang boleh patah: dulu teks ini terpotong. */}
      <div role="status" className="text-xs leading-normal [overflow-wrap:anywhere]">
        {chromium.overrideInvalid ? <p className="m-0 text-destructive">{ADVANCED_TEXT.chromiumOverrideInvalid}</p>
          : chromium.active ? (
            <p className="m-0 opacity-80">
              {chromium.source === 'override' ? ADVANCED_TEXT.chromiumUsingOverride : ADVANCED_TEXT.chromiumUsingAuto}{' '}
              <code className="break-all">{chromium.active}</code>
            </p>
          ) : <p className="m-0 opacity-80">{ADVANCED_TEXT.chromiumMissing}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={INPUT_ID} className="min-w-48 flex-1" value={path}
          placeholder={auto ? ADVANCED_TEXT.chromiumAuto(auto) : ADVANCED_TEXT.chromiumPlaceholder}
          onChange={(e) => setPath(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={path.trim() === chromium.value.trim()}
          onClick={() => void save(path)}>{ADVANCED_TEXT.chromiumSave}</Button>
        {chromium.value !== '' ? (
          <Button size="sm" variant="outline" onClick={() => void save('')}>{ADVANCED_TEXT.chromiumUseAuto}</Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void redetect()}>{ADVANCED_TEXT.chromiumRedetect}</Button>
      </div>
      {chromium.candidates.length > 0 ? <span className="text-xs opacity-70">{ADVANCED_TEXT.chromiumCandidates}</span> : null}
      {chromium.candidates.length > 0 ? (
        <ul aria-label={ADVANCED_TEXT.chromiumCandidates} className="m-0 flex list-none flex-col gap-0.5 p-0">
          {chromium.candidates.map((c) => (
            <li key={c} className="min-w-0">
              <Button size="xs" variant="ghost" aria-pressed={path === c}
                className="w-full justify-start text-left whitespace-normal break-all"
                onClick={() => setPath(c)}><code>{c}</code></Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
