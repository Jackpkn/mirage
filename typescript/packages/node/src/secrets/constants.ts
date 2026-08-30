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

import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'

import { AWSSMConfig, DotenvConfig, EnvConfig } from './config.ts'

/** The builtin source names this module registers, sorted. */
export const BUILTIN_SOURCE_NAMES = ['aws-sm', 'dotenv', 'env'] as const

// Builtin fetchers load lazily: each registered fetch dynamically
// imports its module on first use, so a source's SDK loads only when a
// workspace actually uses it (Python spells the same table as import
// paths beside its core registry). Registration itself runs at import
// time -- the compression-codec pattern -- because core's registry
// cannot name node modules; the node Workspace and the config door both
// import this module, so either entry point arms the builtins.
registerSecrets('env', EnvConfig, async (config, ref) =>
  (await import('./env.ts')).fetchEnv(config, ref),
)
registerSecrets('dotenv', DotenvConfig, async (config, ref) =>
  (await import('./dotenv.ts')).fetchDotenv(config, ref),
)
registerSecrets('aws-sm', AWSSMConfig, async (config, ref) =>
  (await import('./aws.ts')).fetchAwsSm(config, ref),
)
