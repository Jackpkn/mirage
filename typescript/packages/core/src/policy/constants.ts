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

import type { ApprovalDecision } from './types.ts'

/**
 * A whole-command refusal exits as bash does for a command it found but
 * may not run.
 */
export const POLICY_DENIED_EXIT = 126

/**
 * The reason a bare command pattern under `commands.deny` carries, and
 * the one a bare pattern under `commands.ask` carries.
 */
export const DEFAULT_DENY_REASON = 'denied by policy'
export const DEFAULT_ASK_REASON = 'no standing approval'

/**
 * The one pattern token that matches any one line token; trailing, it
 * matches whatever follows, which a prefix already does.
 */
export const WILDCARD = '*'

/**
 * The approval decisions that answer one retry of the exact line (the
 * words and cwd of the request) and are consumed by it; `allow_session`
 * is the one that covers the rule and stays.
 */
export const EXACT_LINE_DECISIONS: ReadonlySet<ApprovalDecision> = new Set(['allow_once', 'deny'])
