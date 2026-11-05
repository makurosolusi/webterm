import { createContext, useContext } from 'react'

export interface NodeHostState { inTab: boolean; visible: boolean }

export const NodeHostContext = createContext<NodeHostState>({ inTab: false, visible: true })
export const useNodeHost = (): NodeHostState => useContext(NodeHostContext)
