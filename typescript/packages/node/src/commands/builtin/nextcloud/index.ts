import { makeGenericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { NEXTCLOUD_IO } from './io.ts'

export const NEXTCLOUD_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<NextcloudAccessor>(ResourceName.NEXTCLOUD, NEXTCLOUD_IO),
]
