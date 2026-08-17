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

import type { PageFetch } from '../../types.ts'

/**
 * Collect every item from a cursor-paginated endpoint.
 *
 * The reply protocol is the `results` / `has_more` / `next_cursor` shape
 * (Notion's). Where the resume cursor goes on the request — a
 * `start_cursor` body field, a query parameter — is the caller's, so
 * `fetchPage` owns that merge. Pagination stops when the reply stops
 * claiming more, or claims more without a usable cursor. `maxResults`
 * stops early and slices the tail of the last page.
 */
export async function cursorItems(fetchPage: PageFetch, maxResults?: number): Promise<unknown[]> {
  const collected: unknown[] = []
  let cursor: string | null = null
  for (;;) {
    const data = await fetchPage(cursor)
    if (Array.isArray(data.results)) collected.push(...(data.results as unknown[]))
    if (maxResults !== undefined && collected.length >= maxResults) {
      return collected.slice(0, maxResults)
    }
    const next = data.next_cursor
    if (data.has_more !== true || typeof next !== 'string' || next === '') {
      return collected
    }
    cursor = next
  }
}
