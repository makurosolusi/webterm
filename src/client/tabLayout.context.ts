import { createContext, useContext } from 'react'

/** Where a node's host sits: a tab pane (`inTab`), the canvas-area maximize overlay (`maximized`), or its canvas slot. */
export interface NodeHostState { inTab: boolean; visible: boolean; maximized: boolean }

export const NodeHostContext = createContext<NodeHostState>({ inTab: false, visible: true, maximized: false })
export const useNodeHost = (): NodeHostState => useContext(NodeHostContext)
