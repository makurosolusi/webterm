// Every tab of the Central control panel, in display order: the one list the panel (`CentralControlPanel`)
// and the URL's `?ctab=` (`appRoute`) share. No imports, so the start-up chunk and the store can take it cycle-free.
export const CENTRAL_PANEL_TABS = ['status', 'abilities', 'agents', 'skills', 'memory', 'health'] as const
export type CentralPanelTab = (typeof CENTRAL_PANEL_TABS)[number]
