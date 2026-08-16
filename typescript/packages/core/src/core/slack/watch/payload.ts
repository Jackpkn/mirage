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

import type { JsonValue } from '../../../types.ts'
import { field, textField } from '../../../watch/index.ts'

/**
 * UTC day directory for a Slack timestamp.
 *
 * Bucketing is UTC because `dateRange` in `readdir` is, so a 6pm PDT message
 * belongs to the *next* day's directory. Reading the consumer's local clock
 * here would name a directory the mount does not serve, and a notify on a path
 * that does not exist is silent.
 */
export function dayOf(ts: string): string | null {
  // `Number('')` and `Number(' ')` are 0, where python's `float` raises, so an
  // empty ts would silently bucket into 1970 rather than being skipped.
  if (ts.trim() === '') return null
  const seconds = Number(ts)
  if (!Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/**
 * Channel and ts a reaction or pin event points at.
 *
 * Both wrap the thing they happened to in an `item` rather than naming it at
 * the top level, and both spell the id `channel` inside it where `file_shared`
 * spells it `channel_id` outside.
 */
export function itemChannel(payload: JsonValue): [string | null, string | null] {
  const item = field(payload, 'item')
  if (item === undefined) return [null, null]
  return [textField(item, 'channel') ?? null, textField(item, 'ts') ?? null]
}

/**
 * The ts whose day a message event belongs in.
 *
 * Not always the event's own `ts`: an edit and a deletion both arrive stamped
 * now while naming a message from any earlier day, so taking the top-level ts
 * would refresh today's directory and leave the day that actually changed
 * stale.
 */
export function messageTs(payload: JsonValue): string | null {
  const subtype = textField(payload, 'subtype')
  if (subtype === 'message_deleted') {
    const deleted = textField(payload, 'deleted_ts')
    if (deleted !== undefined) return deleted
    const previous = field(payload, 'previous_message')
    return previous === undefined ? null : (textField(previous, 'ts') ?? null)
  }
  if (subtype === 'message_changed') {
    const message = field(payload, 'message')
    const changed = message === undefined ? undefined : textField(message, 'ts')
    if (changed !== undefined) return changed
  }
  return textField(payload, 'ts') ?? null
}

/**
 * The conversation id a listing event names.
 *
 * Slack spells it two ways for the same family: `channel_deleted` sends the
 * bare id, `channel_rename` sends the whole channel object.
 */
export function channelIdOf(payload: JsonValue): string | null {
  const direct = textField(payload, 'channel')
  if (direct !== undefined) return direct
  const channel = field(payload, 'channel')
  return channel === undefined ? null : (textField(channel, 'id') ?? null)
}
