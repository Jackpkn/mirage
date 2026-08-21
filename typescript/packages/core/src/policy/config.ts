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

import type { CommandRule, Outcome } from './types.ts'

/** The role's answer about one line, and what produced it. */
export interface Decision {
  /** Which verb spoke. */
  readonly outcome: Outcome
  /** The rule that spoke; null on RUN and on NOT_ALLOWED, which is the allow list rather than a rule. */
  readonly rule: CommandRule | null
  /**
   * The operand a path-scoped rule matched, as typed, which the GNU
   * voice prints (`rm: letters.txt: <reason>`); null when the rule
   * reaches the whole line.
   */
  readonly matchedPath: string | null
  /**
   * Where in the document the rule was written, for a host reading a
   * verdict: `top` or `mounts./repo`. Empty on RUN.
   */
  readonly source: string
  /**
   * Every ask that won a subject of its own, `rule` among them, in the
   * order the subjects were read. Only ASK fills it, and the line runs
   * only once each has been answered: one nod covers the subject it was
   * given for and no other, so a deeper ask on a destination cannot
   * carry a source past the ask written for it. One entry is the
   * ordinary case.
   */
  readonly asks: readonly CommandRule[]
}
