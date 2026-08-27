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

import { DATA_SOURCE_VERSION, DEFAULT_API_VERSION, MAX_PAGE_SIZE } from './config.ts'
import type { BlockRow, CommentRow, DatabaseRow, Json, MetaRow, PageRow } from './types.ts'
import type { JsonValue, Minter, Reply } from '../kit/typescript/index.ts'

export function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

export function intOr(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

export function cursorOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parentJson(parentType: string, parentId: string | null): Json {
  if (parentType === 'workspace') return { type: 'workspace', workspace: true }
  return { type: parentType, [parentType]: parentId ?? '' }
}

export function pageJson(row: PageRow): Json {
  const out: Json = {
    object: 'page',
    id: row.id,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    created_by: { object: 'user', id: row.createdBy },
    last_edited_by: { object: 'user', id: row.lastEditedBy },
    parent: pageParentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    url: row.url,
    properties: JSON.parse(row.propertiesJson) as Json,
  }
  if (row.iconJson !== null) out.icon = JSON.parse(row.iconJson) as Json
  if (row.coverJson !== null) out.cover = JSON.parse(row.coverJson) as Json
  return out
}

// Since 2025-09-03 a database holds data sources and the rows live under one
// of them. The fake derives one data source per database with a *distinct*
// deterministic id, so `db -> data source` resolution is really exercised
// rather than collapsing into an identity that would hide an id mix-up.
export function dataSourceIdOf(databaseId: string): string {
  return `d5000000${databaseId.slice(8)}`
}

// A row's parent is its data source, not its database (2025-09-03). The
// database id rides along because Notion kept emitting it through the
// migration; storage still keys rows by database id, which is the same fact
// one derivation away.
//
// Deliberately not versioned, unlike `databaseJson`: 2022-06-28 answers
// `{type: "database_id", database_id}` with no data source, so a legacy caller
// reads a parent shape its generation never had. Left as one shape on purpose,
// because no in-repo or MCP caller reads `parent` off a row, and the divergence
// is drawn from Notion's upgrade guide rather than probed against the real API
// the way the schema behaviour was. Probe it before rendering both.
function pageParentJson(parentType: string, parentId: string | null): Json {
  if (parentType !== 'database_id' || parentId === null) {
    return parentJson(parentType, parentId)
  }
  return {
    type: 'data_source_id',
    data_source_id: dataSourceIdOf(parentId),
    database_id: parentId,
  }
}

export function databaseIdOf(dataSourceId: string, databases: DatabaseRow[]): string | null {
  for (const row of databases) {
    if (dataSourceIdOf(row.id) === dataSourceId) return row.id
  }
  return null
}

export function dataSourceJson(row: DatabaseRow): Json {
  return {
    object: 'data_source',
    id: dataSourceIdOf(row.id),
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    parent: { type: 'database_id', database_id: row.id },
    database_parent: parentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    title: JSON.parse(row.titleJson) as JsonValue[],
    description: [],
    properties: JSON.parse(row.propertiesJson) as Json,
  }
}

// The 2025-09-03 database object is a container, not a schema: `properties`
// moved to the data source and is deliberately absent there, so anything that
// still reads a column list off a modern database fails loudly instead of
// silently rendering an empty one.
//
// A 2022-06-28 caller gets the pre-split object back, because that is what real
// Notion answers it with: upstream calls the new behavior a *repurposing* of
// Retrieve a Database, and a connection on the old version "will continue to
// work with existing databases that have a single data source". Answering one
// shape to both versions is worse than either, and it cost a graded run: the
// agent could not learn a select column's options, wrote a value outside them,
// and Notion mints an unknown select option rather than rejecting it, so
// nothing told it. `data_sources` is absent from that answer for the same
// reason `properties` is absent from the modern one: the field did not exist
// at that version.
export function databaseJson(row: DatabaseRow, version: string = DEFAULT_API_VERSION): Json {
  const out: Json = {
    object: 'database',
    ...(version < DATA_SOURCE_VERSION
      ? { properties: JSON.parse(row.propertiesJson) as Json }
      : { data_sources: [{ id: dataSourceIdOf(row.id), name: row.titleText }] }),
    id: row.id,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    parent: parentJson(row.parentType, row.parentId),
    archived: row.inTrash,
    in_trash: row.inTrash,
    is_inline: row.isInline,
    url: row.url,
    title: JSON.parse(row.titleJson) as JsonValue[],
  }
  if (row.descriptionJson !== null) {
    out.description = JSON.parse(row.descriptionJson) as JsonValue[]
  }
  return out
}

// Key order is load-bearing: mirage embeds the block verbatim in page.json, so
// the golden pins {object, id, type, has_children, <type>} exactly.
export function blockJson(row: BlockRow): Json {
  return {
    object: 'block',
    id: row.id,
    type: row.type,
    has_children: row.hasChildren,
    [row.type]: JSON.parse(row.payloadJson) as Json,
  }
}

// Mirrors mirage's own _rich_text_to_md / _block_to_md so the /markdown
// endpoint and page.json's `markdown` field cannot disagree about the same
// blocks. Probed against live Notion: the response is

export function commentJson(row: CommentRow): Json {
  return {
    object: 'comment',
    id: row.id,
    parent: parentJson(row.parentType, row.parentId),
    discussion_id: row.discussionId,
    created_time: row.createdTime,
    last_edited_time: row.lastEditedTime,
    created_by: { object: 'user', id: row.createdBy },
    rich_text: JSON.parse(row.richTextJson) as JsonValue[],
  }
}

// Notion's cursor is opaque, so an offset is a legal implementation and keeps
// the page boundary stable under the deterministic orderings used below.
export function pageOf(items: Json[], startCursor: string | null, pageSize: number): Json {
  const offset = startCursor === null ? 0 : Number.parseInt(startCursor, 10)
  const start = Number.isNaN(offset) ? 0 : offset
  const size = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE)
  const slice = items.slice(start, start + size)
  const next = start + size
  const more = next < items.length
  return {
    object: 'list',
    results: slice,
    has_more: more,
    next_cursor: more ? String(next) : null,
  }
}

export function apiError(status: number, code: string, message: string): Reply {
  return { status, body: { object: 'error', status, code, message } }
}

export function notFound(kind: string, id: string): Reply {
  return apiError(
    404,
    'object_not_found',
    `Could not find ${kind} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  )
}

// Created ids are a per-workspace counter rather than a random uuid so the
// battery can pin them in a golden; the leading group says what was minted.
// The kit's Minter is configured `global`, which is the same single counter
// the fake this replaces kept per workspace: creating a page advances the
// number the next block would get.
export function idAt(prefix: string, seq: number): string {
  return `${prefix}-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

export function mintId(minter: Minter, prefix: string): string {
  return idAt(prefix, minter.next(prefix))
}

export function defaultUrl(meta: MetaRow, id: string): string {
  return `${meta.urlBase}${id.replaceAll('-', '')}`
}
