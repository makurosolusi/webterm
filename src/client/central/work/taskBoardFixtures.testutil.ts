import { act, fireEvent, screen } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import type { AssignmentView, BoardColumn, TaskCard, WorkEventView, WorkStatus } from '../../../shared/centralWork'
import { boardColumnOf } from '../../../shared/centralWork'
import type { TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import type { ColumnState } from './taskBoardModel'

// jsdom lacks the APIs the Radix select calls when it opens.
export function shimRadixSelect(): void {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
}

export const assignment = (over: Partial<AssignmentView> = {}): AssignmentView => ({
  id: 'a1', taskId: 't', projectId: 'p1', nodeId: 'node-1', agentId: null, channel: 'terminal', instruction: 'do it', attempt: 1, startedAt: 1000,
  lastSignal: 'busy', lastSignalAt: Date.now() - 120_000, nudgedAt: null, restarts: 0, endedAt: null, endReason: null, result: null, conversationId: null, turnId: null, ...over,
})

export const card = (id: string, status: WorkStatus, over: Partial<TaskCard> = {}): TaskCard => ({
  id, projectId: 'p1', title: `Task ${id}`, objective: `Objective ${id}`, status, boundaries: ['src/a'], acceptance: 'review', dueAt: null, createdBy: 'central', conversationId: null, turnId: null,
  verification: null, createdAt: Date.now() - 60_000, updatedAt: Date.now(), projectName: 'Alpha', column: boardColumnOf(status), assignment: null, nodeName: null, nodeExists: false, lastRule: null, blockedBy: [], ...over,
})

export const page = (...items: TaskCard[]): ColumnState => ({ items, hasMore: false })
export const event = (seq: number, over: Partial<WorkEventView> = {}): WorkEventView => ({
  seq, at: 1_700_000_000_000 + seq * 1000, actor: 'central', kind: 'work.task.running', taskId: 'x', from: 'assigned', to: 'running', reason: null, rule: null, assignmentId: null, nodeId: null, conversationId: null, turnId: null, ...over,
})

export function makeClient(columns: Partial<Record<BoardColumn, ColumnState>>, over: Partial<TaskBoardClient> = {}) {
  const client = {
    listColumn: vi.fn(async (column: BoardColumn) => columns[column] ?? page()),
    getTask: vi.fn(async (id: string) => ({ task: card(id, 'running'), assignments: [], timeline: [], hasMoreTimeline: false })),
    act: vi.fn(async () => undefined),
    getAutoDone: vi.fn(async () => false),
    setAutoDone: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]),
    ...over,
  }
  return client as unknown as { [K in keyof TaskBoardClient]: Mock<TaskBoardClient[K]> }
}

export const column = (name: BoardColumn) => screen.getByRole('region', { name: TL.columns[name] })
export const named = (action: string, title: string) => TL.actionOn(action, title)
export const pickProject = async (name: string): Promise<void> => {
  fireEvent.keyDown(screen.getByRole('combobox', { name: TL.projectFilter }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name }))
}
export const backgroundRefresh = (): void => { act(() => { document.dispatchEvent(new Event('visibilitychange')) }) }
