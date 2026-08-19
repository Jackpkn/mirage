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

import { sha1Hex } from '../utils/hash.ts'
import type { ApprovalDecision, ApprovalRequest } from './types.ts'

/**
 * How the host answers an asked line. Called by the approval door with
 * the request the agent's line raised. `null` means the host has not
 * decided: the door refuses the line for now (126, `requires approval`)
 * and the agent learns the answer by retrying. Any other answer applies
 * at once. Mirrors the Python Approver.
 */
export interface Approver {
  approve(request: ApprovalRequest): Promise<ApprovalDecision | null>
}

/**
 * The id of an approval request: a digest of what was asked, so a retry
 * of the same line in the same session asks the same question and the
 * host answers it once. `argv` is the line as expanded, command name
 * first. Byte-identical to the Python `request_id`.
 */
export async function requestId(
  sessionId: string,
  cwd: string,
  argv: readonly string[],
): Promise<string> {
  const enc = new TextEncoder()
  const parts = [sessionId, cwd, ...argv].map((part) => enc.encode(part + '\0'))
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return (await sha1Hex(bytes)).slice(0, 12)
}

/**
 * The default approver: records the request and answers pending.
 * Non-blocking, for a host that reads `ws.approvals` later (a REST
 * poll, a CLI listing) rather than one that can answer inside the line.
 * The pending ledger is keyed by request id, so a retry of the same
 * line adds nothing and the agent keeps quoting one id.
 */
export class RecordApprover implements Approver {
  private readonly ledger = new Map<string, ApprovalRequest>()

  approve(request: ApprovalRequest): Promise<ApprovalDecision | null> {
    if (!this.ledger.has(request.id)) this.ledger.set(request.id, request)
    return Promise.resolve(null)
  }

  /** The requests nobody has answered, oldest first. */
  pending(): readonly ApprovalRequest[] {
    return [...this.ledger.values()]
  }

  /**
   * Remove and return one pending request; throws when no pending
   * request has that id.
   */
  take(approvalId: string): ApprovalRequest {
    const request = this.ledger.get(approvalId)
    if (request === undefined) throw new Error(`no pending approval ${approvalId}`)
    this.ledger.delete(approvalId)
    return request
  }
}

/**
 * An approver that waits on the host: the line blocks the way a tool
 * call blocks on a permission prompt. `timeoutMs` bounds the wait, after
 * which the request counts as denied; omitted waits.
 */
export class CallbackApprover implements Approver {
  constructor(
    private readonly fn: (request: ApprovalRequest) => Promise<ApprovalDecision>,
    private readonly timeoutMs?: number,
  ) {}

  async approve(request: ApprovalRequest): Promise<ApprovalDecision | null> {
    if (this.timeoutMs === undefined) return this.fn(request)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<ApprovalDecision>((resolve) => {
      timer = setTimeout(() => {
        resolve('deny')
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([this.fn(request), expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
