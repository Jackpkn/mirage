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

import { Clock, Minter, ResetBodyError, checkName } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { seedCalendars, seedForms } from './seed.ts'
import { GwsState } from './store/state.ts'
import { asObjArr, isObj } from './wire/json.ts'

// gws's own /reset shape, kept because every runner already sends it: an
// epoch to pin the clock, a calendar time zone, and two seed channels the
// API itself cannot express (a calendar you do not own, a form carrying
// responses). The kit's generic reset body is a fixture name plus tenants,
// which gws has no store to seed yet; the two converge when gws moves onto
// Prisma. Unknown fields are refused rather than ignored, the way the kit's
// own parser refuses them.
const KNOWN = new Set(['run', 'epoch', 'calendarTimeZone', 'calendars', 'forms'])

export interface GwsReset {
  run: string
  epoch?: string
  calendarTimeZone?: string
  calendars: JsonValue
  forms: JsonValue
}

function arrayField(name: string, value: JsonValue | undefined): JsonValue {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw new ResetBodyError(`/reset ${name} must be a list`)
  return value
}

export function parseGwsReset(raw: JsonValue): GwsReset {
  if (!isObj(raw)) throw new ResetBodyError('reset body must be a JSON object')
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k))
  if (unknown.length > 0) {
    throw new ResetBodyError(`unknown /reset fields: ${unknown.sort().join(', ')}`)
  }
  const run = raw.run === undefined ? 'default' : raw.run
  if (typeof run !== 'string') throw new ResetBodyError('/reset run must be a string')
  const epoch = raw.epoch
  if (epoch !== undefined && typeof epoch !== 'string') {
    throw new ResetBodyError('/reset epoch must be an ISO string')
  }
  const tz = raw.calendarTimeZone
  if (tz !== undefined && typeof tz !== 'string') {
    throw new ResetBodyError('/reset calendarTimeZone must be a string')
  }
  // Present but not a list is refused rather than skipped. The old fake threw
  // a TypeError on `{"calendars": null}` and answered 500; seeding nothing and
  // answering `{"ok":true}` would turn that loud failure into a silent one,
  // and a harness whose seed quietly did nothing is the worst way to find out.
  const calendars = arrayField('calendars', raw.calendars)
  const forms = arrayField('forms', raw.forms)
  const out: GwsReset = {
    run: checkName('run', run),
    calendars,
    forms,
  }
  if (epoch !== undefined) out.epoch = epoch
  if (tz !== undefined) out.calendarTimeZone = tz
  return out
}

export function buildState(req: GwsReset, mintSharing: 'global' | 'per-kind'): GwsState {
  const st = new GwsState(new Clock(req.epoch), new Minter(mintSharing), req.calendarTimeZone)
  if (req.calendars !== null) seedCalendars(st, asObjArr(req.calendars))
  if (req.forms !== null) seedForms(st, asObjArr(req.forms))
  return st
}
