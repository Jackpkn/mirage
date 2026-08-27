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

import type { C } from './config.ts'
import { DEFAULT_API_VERSION } from './config.ts'
import { plainTextOf } from './text.ts'
import type { DatabaseRow, Json, PageRow } from './types.ts'
import { asObject, dataSourceJson, databaseJson, pageJson } from './wire.ts'

export async function searchResults(
  db: C,
  tenant: string,
  args: Json,
  version: string = DEFAULT_API_VERSION,
): Promise<Json[]> {
  const filter = asObject(args.filter)
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : ''
  const matches = (title: string): boolean => query === '' || title.toLowerCase().includes(query)
  // 2022-06-28 spells this "database"; 2026-03-11 replaced it with
  // "data_source" and rejects the old word. The fake answers both so the
  // battery's client and the official CLI can share one server.
  if (filter.value === 'database' || filter.value === 'data_source') {
    const rows = (await db.notionDatabase.findMany({
      where: { tenant, inTrash: false },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })) as DatabaseRow[]
    const kept = rows.filter((r) => matches(r.titleText))
    return filter.value === 'data_source'
      ? kept.map(dataSourceJson)
      : kept.map((r) => databaseJson(r, version))
  }
  const rows = (await db.notionPage.findMany({
    where: { tenant, inTrash: false },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as PageRow[]
  return rows.filter((r) => matches(r.titleText)).map(pageJson)
}

function propByName(page: Json, name: string): Json | undefined {
  const value = asObject(page.properties)[name]
  return value === undefined ? undefined : asObject(value)
}

function textOfProp(prop: Json): string {
  if (Array.isArray(prop.title)) return plainTextOf(prop.title)
  if (Array.isArray(prop.rich_text)) return plainTextOf(prop.rich_text)
  return ''
}

function numberOfProp(prop: Json): number | null {
  return typeof prop.number === 'number' ? prop.number : null
}

function matchesText(value: string, cond: Json): boolean {
  if (typeof cond.equals === 'string') return value === cond.equals
  if (typeof cond.does_not_equal === 'string') return value !== cond.does_not_equal
  if (typeof cond.contains === 'string') return value.includes(cond.contains)
  if (typeof cond.does_not_contain === 'string') return !value.includes(cond.does_not_contain)
  if (typeof cond.starts_with === 'string') return value.startsWith(cond.starts_with)
  if (typeof cond.ends_with === 'string') return value.endsWith(cond.ends_with)
  if (cond.is_empty === true) return value === ''
  if (cond.is_not_empty === true) return value !== ''
  return true
}

function matchesNumber(value: number | null, cond: Json): boolean {
  if (cond.is_empty === true) return value === null
  if (cond.is_not_empty === true) return value !== null
  if (value === null) return false
  if (typeof cond.equals === 'number') return value === cond.equals
  if (typeof cond.does_not_equal === 'number') return value !== cond.does_not_equal
  if (typeof cond.greater_than === 'number') return value > cond.greater_than
  if (typeof cond.less_than === 'number') return value < cond.less_than
  const gte = cond.greater_than_or_equal_to
  if (typeof gte === 'number') return value >= gte
  const lte = cond.less_than_or_equal_to
  if (typeof lte === 'number') return value <= lte
  return true
}

// Notion's filter is a recursive and/or tree over typed property conditions.
// Implemented here for the types the battery's fixtures use (title/rich_text,
// number, checkbox, select); an unrecognized condition matches rather than
// silently dropping the row, so a filter this does not understand degrades to
// "no filter" instead of "no results".
function matchesFilter(page: Json, filter: Json): boolean {
  if (Array.isArray(filter.and)) return filter.and.every((f) => matchesFilter(page, asObject(f)))
  if (Array.isArray(filter.or)) return filter.or.some((f) => matchesFilter(page, asObject(f)))
  const name = typeof filter.property === 'string' ? filter.property : ''
  if (name === '') return true
  const prop = propByName(page, name)
  if (prop === undefined) return false
  if (filter.title !== undefined || filter.rich_text !== undefined) {
    return matchesText(textOfProp(prop), asObject(filter.title ?? filter.rich_text))
  }
  if (filter.number !== undefined) {
    return matchesNumber(numberOfProp(prop), asObject(filter.number))
  }
  if (filter.checkbox !== undefined) {
    const cond = asObject(filter.checkbox)
    const value = prop.checkbox === true
    if (typeof cond.equals === 'boolean') return value === cond.equals
    if (typeof cond.does_not_equal === 'boolean') return value !== cond.does_not_equal
    return true
  }
  if (filter.select !== undefined) {
    const name2 = asObject(prop.select).name
    return matchesText(typeof name2 === 'string' ? name2 : '', asObject(filter.select))
  }
  return true
}

function sortKey(page: Json, sort: Json): string | number {
  if (typeof sort.timestamp === 'string') {
    const key = sort.timestamp === 'created_time' ? 'created_time' : 'last_edited_time'
    return typeof page[key] === 'string' ? String(page[key]) : ''
  }
  const prop = propByName(page, typeof sort.property === 'string' ? sort.property : '')
  if (prop === undefined) return ''
  const num = numberOfProp(prop)
  return num === null ? textOfProp(prop) : num
}

// Plain < / > rather than localeCompare: collation must not differ between a
// CI runner and a laptop, since the row order lands in a golden.
function applySorts(rows: Json[], sorts: unknown): Json[] {
  if (!Array.isArray(sorts) || sorts.length === 0) return rows
  const out = [...rows]
  out.sort((a, b) => {
    for (const raw of sorts) {
      const sort = asObject(raw)
      const ka = sortKey(a, sort)
      const kb = sortKey(b, sort)
      const cmp = ka < kb ? -1 : ka > kb ? 1 : 0
      if (cmp !== 0) return sort.direction === 'descending' ? -cmp : cmp
    }
    return 0
  })
  return out
}

export async function databaseRows(
  db: C,
  tenant: string,
  databaseId: string,
  args: Json,
): Promise<Json[]> {
  const rows = (await db.notionPage.findMany({
    where: { tenant, parentType: 'database_id', parentId: databaseId, inTrash: false },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })) as PageRow[]
  let out = rows.map(pageJson)
  if (args.filter !== undefined) {
    out = out.filter((row) => matchesFilter(row, asObject(args.filter)))
  }
  return applySorts(out, args.sorts)
}

// A child page is one object in two tables: the NotionPage row is the record,
// the NotionBlock row of type child_page is how the parent's children listing
