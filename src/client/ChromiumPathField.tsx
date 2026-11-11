// Butir "Lokasi Chromium" di Lanjutan: server mencari sendiri (path aktif + kandidat di disk), pengguna
// boleh menimpa dengan path sendiri atau kembali ke otomatis.
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ADVANCED_TEXT } from './advancedLabels'
import { SettingsCombobox } from './SettingsCombobox'

const INPUT_ID = 'capabilities-chromium'

export interface ChromiumPathFieldProps {
  chromium: CapabilitiesResponse['advanced']['chromiumPath']
  /** Simpan override; '' = hapus override (pakai otomatis). */
  save(path: string): Promise<void>
  /** Muat ulang dari server; deteksi berjalan ulang di tiap GET. */
  redetect(): Promise<unknown>
}

/** Path aktif + sumbernya, combobox (kandidat di disk + path yang pernah dipakai) yang menyimpan saat dipilih/Enter/blur, dan kembali ke otomatis. */
export function ChromiumPathField({ chromium, save, redetect }: ChromiumPathFieldProps): React.JSX.Element {
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
        <span className="min-w-48 flex-1">
          <SettingsCombobox id={INPUT_ID} fieldId="browser.chromiumPath" mono value={chromium.value}
            presets={chromium.candidates.map((c) => ({ value: c }))}
            placeholder={auto ? ADVANCED_TEXT.chromiumAuto(auto) : ADVANCED_TEXT.chromiumPlaceholder}
            onCommit={(p) => void save(p)} />
        </span>
        {chromium.value !== '' ? (
          <Button size="sm" variant="outline" onClick={() => void save('')}>{ADVANCED_TEXT.chromiumUseAuto}</Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void redetect()}>{ADVANCED_TEXT.chromiumRedetect}</Button>
      </div>
    </div>
  )
}
