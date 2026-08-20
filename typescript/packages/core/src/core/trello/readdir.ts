// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { TrelloAccessor } from '../../accessor/trello.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import {
  listBoardLabels,
  listBoardLists,
  listBoardMembers,
  listListCards,
  listWorkspaceBoards,
  listWorkspaces,
} from './client.ts'
import {
  normalizeBoard,
  normalizeCard,
  normalizeLabel,
  normalizeList,
  normalizeMember,
  normalizeWorkspace,
  toJsonBytes,
} from './normalize.ts'
import {
  boardDirname,
  cardDirname,
  labelFilename,
  listDirname,
  memberFilename,
  workspaceDirname,
} from './pathing.ts'
import { detectScope } from './scope.ts'

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

async function filteredWorkspaces(accessor: TrelloAccessor): Promise<Record<string, unknown>[]> {
  let workspaces = await listWorkspaces(accessor.transport)
  if (accessor.workspaceId !== null && accessor.workspaceId !== '') {
    workspaces = workspaces.filter((w) => pickString(w, 'id') === accessor.workspaceId)
  }
  return workspaces
}

async function filteredBoards(
  accessor: TrelloAccessor,
  workspaceId: string,
): Promise<Record<string, unknown>[]> {
  let boards = await listWorkspaceBoards(accessor.transport, workspaceId)
  if (accessor.boardIds !== null && accessor.boardIds.length > 0) {
    const allowed = new Set(accessor.boardIds)
    boards = boards.filter((b) => allowed.has(pickString(b, 'id')))
  }
  return boards
}

/**
 * The workspace the slots name, null when no listing carries it.
 *
 * Existence is proven against the workspace listing by the full `label__id`
 * dirname, never by calling the API with the typed id: a bogus id must read
 * as ENOENT, not as a Trello HTTP error.
 */
export async function findWorkspace(
  accessor: TrelloAccessor,
  slots: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  const target = `${slots.workspace ?? ''}__${slots.workspace_id ?? ''}`
  for (const workspace of await filteredWorkspaces(accessor)) {
    if (workspaceDirname(workspace) === target) return workspace
  }
  return null
}

/** The board the slots name, validated through its workspace. */
export async function findBoard(
  accessor: TrelloAccessor,
  slots: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  if ((await findWorkspace(accessor, slots)) === null) return null
  const target = `${slots.board ?? ''}__${slots.board_id ?? ''}`
  for (const board of await filteredBoards(accessor, slots.workspace_id ?? '')) {
    if (boardDirname(board) === target) return board
  }
  return null
}

/** The list the slots name, validated through its board. */
export async function findList(
  accessor: TrelloAccessor,
  slots: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  if ((await findBoard(accessor, slots)) === null) return null
  const target = `${slots.list ?? ''}__${slots.list_id ?? ''}`
  for (const lst of await listBoardLists(accessor.transport, slots.board_id ?? '')) {
    if (listDirname(lst) === target) return lst
  }
  return null
}

/** The card the slots name, validated through its list. */
export async function findCard(
  accessor: TrelloAccessor,
  slots: Readonly<Record<string, string>>,
): Promise<Record<string, unknown> | null> {
  if ((await findList(accessor, slots)) === null) return null
  const target = `${slots.card ?? ''}__${slots.card_id ?? ''}`
  for (const card of await listListCards(accessor.transport, slots.list_id ?? '')) {
    if (cardDirname(card) === target) return card
  }
  return null
}

async function listWorkspacesDir(
  accessor: TrelloAccessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const entries: [string, IndexEntry][] = []
  for (const workspace of await filteredWorkspaces(accessor)) {
    const dirname = workspaceDirname(workspace)
    entries.push([
      dirname,
      new IndexEntry({
        id: pickString(workspace, 'id'),
        name:
          pickString(workspace, 'displayName') ||
          pickString(workspace, 'name') ||
          pickString(workspace, 'id'),
        resourceType: 'trello/workspace',
        remoteTime: '',
        vfsName: dirname,
      }),
    ])
  }
  return entries
}

async function listWorkspace(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const workspace = await findWorkspace(accessor, match.slots)
  if (workspace === null) return null
  // workspace.json renders the workspace object this find already fetched,
  // so its exact size is free here.
  return [
    [
      'workspace.json',
      new IndexEntry({
        id: pickString(workspace, 'id'),
        name: 'workspace.json',
        resourceType: 'trello/workspace_json',
        vfsName: 'workspace.json',
        size: toJsonBytes(normalizeWorkspace(workspace)).byteLength,
      }),
    ],
    [
      'boards',
      new IndexEntry({
        id: pickString(workspace, 'id'),
        name: 'boards',
        resourceType: 'trello/boards_dir',
        vfsName: 'boards',
      }),
    ],
  ]
}

async function listBoards(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findWorkspace(accessor, match.slots)) === null) return null
  const entries: [string, IndexEntry][] = []
  for (const board of await filteredBoards(accessor, match.slots.workspace_id ?? '')) {
    const dirname = boardDirname(board)
    entries.push([
      dirname,
      new IndexEntry({
        id: pickString(board, 'id'),
        name: pickString(board, 'name') || pickString(board, 'id'),
        resourceType: 'trello/board',
        remoteTime: pickString(board, 'dateLastActivity'),
        vfsName: dirname,
      }),
    ])
  }
  return entries
}

async function listBoard(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const board = await findBoard(accessor, match.slots)
  if (board === null) return null
  // board.json's normalizer only uses fields the board listing already
  // carries, so its exact size is free here.
  const remoteTime = pickString(board, 'dateLastActivity')
  const boardId = pickString(board, 'id')
  return [
    [
      'board.json',
      new IndexEntry({
        id: boardId,
        name: 'board.json',
        resourceType: 'trello/board_json',
        vfsName: 'board.json',
        size: toJsonBytes(normalizeBoard(board)).byteLength,
        remoteTime,
      }),
    ],
    [
      'members',
      new IndexEntry({
        id: boardId,
        name: 'members',
        resourceType: 'trello/members_dir',
        vfsName: 'members',
      }),
    ],
    [
      'labels',
      new IndexEntry({
        id: boardId,
        name: 'labels',
        resourceType: 'trello/labels_dir',
        vfsName: 'labels',
      }),
    ],
    [
      'lists',
      new IndexEntry({
        id: boardId,
        name: 'lists',
        resourceType: 'trello/lists_dir',
        vfsName: 'lists',
      }),
    ],
  ]
}

async function listMembers(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findBoard(accessor, match.slots)) === null) return null
  const members = await listBoardMembers(accessor.transport, match.slots.board_id ?? '')
  return members.map((member): [string, IndexEntry] => {
    const filename = memberFilename(member)
    return [
      filename,
      new IndexEntry({
        id: pickString(member, 'id'),
        name:
          pickString(member, 'fullName') ||
          pickString(member, 'username') ||
          pickString(member, 'id'),
        resourceType: 'trello/member',
        remoteTime: '',
        vfsName: filename,
        size: toJsonBytes(normalizeMember(member)).byteLength,
      }),
    ]
  })
}

async function listLabels(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findBoard(accessor, match.slots)) === null) return null
  const labels = await listBoardLabels(accessor.transport, match.slots.board_id ?? '')
  return labels.map((label): [string, IndexEntry] => {
    const filename = labelFilename(label)
    return [
      filename,
      new IndexEntry({
        id: pickString(label, 'id'),
        name: pickString(label, 'name') || pickString(label, 'color') || pickString(label, 'id'),
        resourceType: 'trello/label',
        remoteTime: '',
        vfsName: filename,
        size: toJsonBytes(normalizeLabel(label)).byteLength,
      }),
    ]
  })
}

async function listLists(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findBoard(accessor, match.slots)) === null) return null
  const lists = await listBoardLists(accessor.transport, match.slots.board_id ?? '')
  return lists.map((lst): [string, IndexEntry] => {
    const dirname = listDirname(lst)
    return [
      dirname,
      new IndexEntry({
        id: pickString(lst, 'id'),
        name: pickString(lst, 'name') || pickString(lst, 'id'),
        resourceType: 'trello/list',
        remoteTime: '',
        vfsName: dirname,
      }),
    ]
  })
}

async function listList(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const lst = await findList(accessor, match.slots)
  if (lst === null) return null
  // list.json's normalizer only uses fields the list listing already
  // carries, so its exact size is free here.
  const listId = pickString(lst, 'id')
  return [
    [
      'list.json',
      new IndexEntry({
        id: listId,
        name: 'list.json',
        resourceType: 'trello/list_json',
        vfsName: 'list.json',
        size: toJsonBytes(normalizeList(lst)).byteLength,
      }),
    ],
    [
      'cards',
      new IndexEntry({
        id: listId,
        name: 'cards',
        resourceType: 'trello/cards_dir',
        vfsName: 'cards',
      }),
    ],
  ]
}

async function listCards(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  if ((await findList(accessor, match.slots)) === null) return null
  const cards = await listListCards(accessor.transport, match.slots.list_id ?? '')
  return cards.map((card): [string, IndexEntry] => {
    const dirname = cardDirname(card)
    return [
      dirname,
      new IndexEntry({
        id: pickString(card, 'id'),
        name: pickString(card, 'name') || pickString(card, 'id'),
        resourceType: 'trello/card',
        remoteTime: pickString(card, 'dateLastActivity'),
        vfsName: dirname,
      }),
    ]
  })
}

async function listCard(
  accessor: TrelloAccessor,
  match: ScopeMatch,
): Promise<[string, IndexEntry][] | null> {
  const card = await findCard(accessor, match.slots)
  if (card === null) return null
  // card.json's normalizer only uses fields the card listing already
  // carries, so its exact size is free here; comments.jsonl needs a
  // per-card actions call and stays size-unknown.
  const remoteTime = pickString(card, 'dateLastActivity')
  const cardId = pickString(card, 'id')
  return [
    [
      'card.json',
      new IndexEntry({
        id: cardId,
        name: 'card.json',
        resourceType: 'trello/card_json',
        vfsName: 'card.json',
        size: toJsonBytes(normalizeCard(card)).byteLength,
        remoteTime,
      }),
    ],
    [
      'comments.jsonl',
      new IndexEntry({
        id: cardId,
        name: 'comments.jsonl',
        resourceType: 'trello/comments_jsonl',
        vfsName: 'comments.jsonl',
        remoteTime,
      }),
    ],
  ]
}

export const readdir = makeReaddir<TrelloAccessor>(detectScope, {
  listers: {
    workspaces: listWorkspacesDir,
    workspace: listWorkspace,
    boards: listBoards,
    board: listBoard,
    members: listMembers,
    labels: listLabels,
    lists: listLists,
    list: listList,
    cards: listCards,
    card: listCard,
  },
  staticRoot: ['workspaces'],
})
