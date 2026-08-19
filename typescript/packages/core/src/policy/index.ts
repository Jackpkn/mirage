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

export type { Policy } from './base.ts'
export { PolicyDenied } from './errors.ts'
export { Approvals, askRule } from './approvals.ts'
export { CallbackApprover, RecordApprover, requestId, type Approver } from './approver.ts'
export { MountRootPolicy } from './builtin/mount_root.ts'
export { PermissionsPolicy } from './builtin/permissions.ts'
export { OutputCapPolicy, resolveProducer, resolveLimit } from './builtin/output_cap.ts'
export {
  POLICY_DENIED_EXIT,
  Policies,
  postExecuteGate,
  postOpsGate,
  preOpsGate,
  preSessionGate,
  renderDeny,
  renderPending,
} from './policies.ts'
export { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from './types.ts'
export {
  type Action,
  type ApprovalDecision,
  type ApprovalRequest,
  type Ask,
  type CommandContext,
  type CommandsSpec,
  type Deny,
  type DenyScope,
  type ExecuteResultContext,
  type CommandRule,
  type Grant,
  type GrantScope,
  type OpsContext,
  type OpsResultContext,
  type Pending,
  type SessionCommandsQuery,
  type SessionContext,
  type SessionGrantsQuery,
} from './types.ts'
