// Konteks per-section untuk item Settings: kategori ("Terminal") untuk judul `Kategori: Nama`,
// plus settings aktif + `onChange` supaya sebuah item bisa menilai dirinya "Modified" (beda dari
// `DEFAULT_SETTINGS`) dan menawarkan Reset Setting tanpa tiap pemanggil meneruskan keduanya.
import { createContext, useContext, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { isEntryKey, type SettingsPatch } from '../shared/settings.patch'

interface SettingsItemScope {
  category?: string
  settings?: Settings
  onChange?: (patch: SettingsPatch) => void
}

const ItemContext = createContext<SettingsItemScope>({})

/** Menyediakan kategori + settings + onChange untuk semua `Field` di dalamnya. */
export function SettingsItemScopeProvider({
  category,
  settings,
  onChange,
  children,
}: SettingsItemScope & { children: ReactNode }): React.JSX.Element {
  return <ItemContext.Provider value={{ category, settings, onChange }}>{children}</ItemContext.Provider>
}

export function useSettingsItemScope(): SettingsItemScope {
  return useContext(ItemContext)
}

/** Nilai kunci berbeda dari default? Perbandingan JSON cukup: nilai Settings murni data. */
export function isModified(settings: Settings, key: keyof Settings): boolean {
  return JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])
}

/** Patch yang mengembalikan satu kunci ke defaultnya. Entry keys (`settings.patch.ts`) merge per
 *  entry, so `{}` would remove nothing: their reset deletes each entry of `current` with `null`. */
export function resetPatch(key: keyof Settings, current?: Settings): SettingsPatch {
  if (key === 'claudeLaunchProfiles') {
    // Profiles merge by id too: delete each one, and move the pointers off them in the same write.
    const list = current?.claudeLaunchProfiles ?? []
    const at = (id: string | undefined): boolean => list.some((p) => p.id === id)
    return {
      claudeLaunchProfiles: list.map((p) => ({ id: p.id, deleted: true as const })),
      ...(at(current?.defaultClaudeProfileId) ? { defaultClaudeProfileId: DEFAULT_SETTINGS.defaultClaudeProfileId } : {}),
      ...(at(current?.centralClaudeProfileId) ? { centralClaudeProfileId: DEFAULT_SETTINGS.centralClaudeProfileId } : {}),
    }
  }
  // History length is one control for both buffers (Settings › Terminal): reset both together.
  if (key === 'scrollbackLines') return { scrollbackLines: DEFAULT_SETTINGS.scrollbackLines, scrollbackBytes: DEFAULT_SETTINGS.scrollbackBytes }
  if (isEntryKey(key)) return { [key]: Object.fromEntries(Object.keys(current?.[key] ?? {}).map((id) => [id, null])) }
  return { [key]: DEFAULT_SETTINGS[key] }
}
