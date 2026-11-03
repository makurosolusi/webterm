// Jembatan lompat Channels -> Environment: SettingsPanel mengisi, ChannelsTelegramConfig memanggil untuk kunci
// prasyarat yang dimiliki Environment. Lewat context karena ChannelsSection (milik workstream lain) tak meneruskan prop.
import { createContext } from 'react'

export const OpenEnvContext = createContext<((key: string) => void) | undefined>(undefined)
