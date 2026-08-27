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

import { parseConfig, schemaFor } from '../kit/typescript/index.ts'
import type { KitConfig, KitRoute } from '../kit/typescript/index.ts'
import { calendarRoutes } from './calendar/routes.ts'
import { docsRoutes } from './docs/routes.ts'
import { driveRoutes } from './drive/routes.ts'
import { formsRoutes } from './forms/routes.ts'
import { gmailRoutes } from './gmail/routes.ts'
import { sheetsRoutes } from './sheets/routes.ts'
import { slidesRoutes } from './slides/routes.ts'
import type { GwsState } from './store/state.ts'
import { ok } from './wire/reply.ts'
import { route } from './wire/route.ts'

export const GWS_DEFAULT_PORT = 19999

// `schema` names the proposal at integ/prisma/gws.prisma. Nothing pushes it
// yet: this pass moves gws onto the kit's control plane only, and the store
// is still the in-memory GwsState, so no ClientPool is constructed.
export const gwsConfig: KitConfig = parseConfig({
  service: 'gws',
  schema: schemaFor('gws'),
  defaultPort: GWS_DEFAULT_PORT,
  mintSharing: 'per-kind',
})

// The fake OAuth exchange every google client makes before its first call.
function tokenRoutes(): KitRoute<GwsState>[] {
  return [
    route('POST', '/token', () =>
      ok({ access_token: 'gws-integ-token', expires_in: 3600, token_type: 'Bearer' }),
    ),
  ]
}

// What this fake does NOT model, kept with the route list because a caller
// reading a 404 needs it: every line below is a deliberate simplification, not
// a bug to report against mirage.
//
// Simplified, all deterministic so both language runners see byte-identical
// responses:
//   - ids and timestamps are counters over a fixed clock, not random
//   - `fields` masks are ignored (full resources are returned), except on
//     updateCells, where the mask decides whether values are touched at all
//   - sheets store literal values; formulas are not evaluated
//   - files.list paginates on pageSize/pageToken; the token is the next
//     item's index, so pages are stable for a fixed query
//   - Gmail search matches case-insensitive substrings, not word stems
//
// Known-absent surface, listed so a 404 here reads as "not built yet" rather
// than "mirage sent the wrong request":
//   - Gmail beyond labels.list and messages list/get/insert/send/trash:
//     no messages.modify/untrash/delete/batchModify, no labels CRUD, and no
//     threads or drafts resources at all
//   - drive changes.list / changes.getStartPageToken (needs a change feed)
//   - Sheets requests that need a cell format or style model (repeatCell,
//     copyPaste, conditional formats) and spreadsheets.getByDataFilter;
//     updateCells is served, but only for userEnteredValue, so a format-only
//     request is a no-op
//   - Docs requests that need document structure beyond a text body
//     (insertTable, insertInlineImage, updateTextStyle, bullets)
//   - Slides presentations.pages.getThumbnail, and the shape/table/image
//     geometry requests
//   - Page has no pageType and Sheets no defaultFormat/spreadsheetTheme
//
// Faithful behaviours that matter to the backends, so they are not
// simplifications to "fix": Drive allows duplicate sibling names, folder
// deletes are recursive, creating a file with a google-apps MIME type
// auto-creates the linked Docs/Sheets/Slides resource (and vice versa), every
// content write records a revision that /revisions can list and serve, Gmail
// messages.insert honors internalDateSource=dateHeader, messages.trash swaps
// INBOX for TRASH, Sheets keeps a declared grid per tab beside the sparse cell
// map so an insert or append grows rowCount, object ids are unique across a
// whole presentation so duplicating a slide re-keys its elements, and
// replaceAllText is case-INSENSITIVE unless matchCase is set, in both Docs and
// Slides.
//
// One list, in the order the old single route() function tried its patterns:
// the API-prefixed surfaces first, then Drive, then the editors. Order only
// matters inside a surface, and each module states its own.
export function gwsRoutes(): KitRoute<GwsState>[] {
  return [
    ...tokenRoutes(),
    ...gmailRoutes(),
    ...calendarRoutes(),
    ...formsRoutes(),
    ...driveRoutes(),
    ...docsRoutes(),
    ...sheetsRoutes(),
    ...slidesRoutes(),
  ]
}
