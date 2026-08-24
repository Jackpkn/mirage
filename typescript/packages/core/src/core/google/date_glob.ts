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

import { globSpan } from '../../utils/glob_walk.ts'

/**
 * Translate a date-prefixed glob into an RFC3339 modifiedTime range.
 *
 * Drive's own spelling of the span `globSpan` reads.
 */
export function globToModifiedRange(pattern: string | null | undefined): [string, string] | null {
  const span = globSpan(pattern)
  if (span === null) return null
  return [`${span[0]}T00:00:00Z`, `${span[1]}T00:00:00Z`]
}
