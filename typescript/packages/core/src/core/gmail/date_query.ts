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

function epochSeconds(day: string): number {
  const [y, m, d] = day.split('-')
  const stamp = Date.UTC(
    Number.parseInt(y ?? '', 10),
    Number.parseInt(m ?? '', 10) - 1,
    Number.parseInt(d ?? '', 10),
  )
  return Math.trunc(stamp / 1000)
}

/**
 * A Gmail date filter for a half-open range of UTC days.
 *
 * The bounds are epoch seconds rather than `YYYY/MM/DD` because Gmail reads a
 * written date as "midnight on that date in the PST timezone" and names
 * seconds as the way to mean any other zone, while a message lands in a day
 * directory by its UTC `internalDate`. The two disagree by the account's
 * offset, so a written date would leave the first hours of the requested day
 * outside the query and every message in them out of the listing. The lower
 * bound is a second early because the operator's inclusivity at the exact
 * second is not documented: an extra message from the day before is dropped by
 * the bucketing, a missing one is not recoverable.
 */
export function spanToGmailQuery(start: string, end: string): string {
  return `after:${String(epochSeconds(start) - 1)} before:${String(epochSeconds(end))}`
}

/**
 * A Gmail date filter for one day directory, null when the name is not a
 * well-formed calendar date.
 *
 * The round-trip check is what refuses an impossible day: `Date.UTC` rolls
 * 2026-02-30 into March rather than failing, where python's `date()` raises.
 */
export function dateDirToGmailQuery(name: string): string | null {
  const parts = name.split('-')
  if (parts.length !== 3) return null
  const [y, m, d] = parts
  if (y?.length !== 4 || m?.length !== 2 || d?.length !== 2) return null
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null
  const year = Number.parseInt(y, 10)
  const month = Number.parseInt(m, 10)
  const day = Number.parseInt(d, 10)
  const stamp = Date.UTC(year, month - 1, day)
  const back = new Date(stamp)
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null
  }
  const next = new Date(stamp + 86_400_000)
  const nn = [
    next.getUTCFullYear().toString().padStart(4, '0'),
    (next.getUTCMonth() + 1).toString().padStart(2, '0'),
    next.getUTCDate().toString().padStart(2, '0'),
  ].join('-')
  return spanToGmailQuery(name, nn)
}
