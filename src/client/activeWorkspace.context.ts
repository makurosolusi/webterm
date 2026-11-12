// The workspace open on the board, for surfaces far from App (the Central chat's permission chip).
// Outside the provider (tests, isolated renders) there is none.
import { createContext, useContext } from 'react'

const ActiveWorkspaceContext = createContext<string | null>(null)

export const ActiveWorkspaceProvider = ActiveWorkspaceContext.Provider

/** Id of the open workspace, or null when none is open. */
export const useActiveWorkspaceId = (): string | null => useContext(ActiveWorkspaceContext)
