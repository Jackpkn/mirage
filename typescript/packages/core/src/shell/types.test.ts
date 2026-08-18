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

import { describe, expect, it } from 'vitest'
import {
  BUILTIN_GROUP,
  BuiltinGroup,
  BuiltinTier,
  GRAMMAR_BUILTINS,
  GROUP_TIER,
  NodeType,
  ShellBuiltin,
  TOOL_BUILTINS,
} from './types.ts'

describe('NodeType', () => {
  it('has the load-bearing grammar node types mirroring tree-sitter-bash', () => {
    expect(NodeType.PROGRAM).toBe('program')
    expect(NodeType.COMMAND).toBe('command')
    expect(NodeType.PIPELINE).toBe('pipeline')
    expect(NodeType.REDIRECTED_STATEMENT).toBe('redirected_statement')
    expect(NodeType.COMMAND_NAME).toBe('command_name')
    expect(NodeType.WORD).toBe('word')
    expect(NodeType.STRING).toBe('string')
    expect(NodeType.SIMPLE_EXPANSION).toBe('simple_expansion')
    expect(NodeType.EXPANSION).toBe('expansion')
    expect(NodeType.COMMAND_SUBSTITUTION).toBe('command_substitution')
    expect(NodeType.ARITHMETIC_EXPANSION).toBe('arithmetic_expansion')
  })

  it('has shell operator tokens', () => {
    expect(NodeType.AND).toBe('&&')
    expect(NodeType.OR).toBe('||')
    expect(NodeType.PIPE).toBe('|')
    expect(NodeType.REDIRECT_OUT).toBe('>')
    expect(NodeType.REDIRECT_APPEND).toBe('>>')
  })

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(NodeType)).toBe(true)
  })
})

describe('BuiltinTier', () => {
  it('names the two tiers', () => {
    expect(BuiltinTier.GRAMMAR).toBe('grammar')
    expect(BuiltinTier.TOOL).toBe('tool')
    expect(GRAMMAR_BUILTINS.has(ShellBuiltin.CD)).toBe(true)
    expect(TOOL_BUILTINS.has(ShellBuiltin.PYTHON3)).toBe(true)
  })

  it('partitions ShellBuiltin', () => {
    for (const b of GRAMMAR_BUILTINS) expect(TOOL_BUILTINS.has(b)).toBe(false)
    const union = new Set<string>([...GRAMMAR_BUILTINS, ...TOOL_BUILTINS])
    expect(union).toEqual(new Set<string>(Object.values(ShellBuiltin)))
  })
})

describe('BuiltinGroup', () => {
  it('has one row per ShellBuiltin', () => {
    expect(new Set(BUILTIN_GROUP.keys())).toEqual(new Set(Object.values(ShellBuiltin)))
    const groups = new Set<string>(Object.values(BuiltinGroup))
    for (const g of BUILTIN_GROUP.values()) expect(groups.has(g)).toBe(true)
  })

  it('gives every group a tier and a member', () => {
    expect(new Set(GROUP_TIER.keys())).toEqual(new Set(Object.values(BuiltinGroup)))
    expect(new Set(BUILTIN_GROUP.values())).toEqual(new Set(Object.values(BuiltinGroup)))
  })

  it('derives the tier sets from the rows', () => {
    for (const [b, g] of BUILTIN_GROUP) {
      const tier = GROUP_TIER.get(g)
      expect(GRAMMAR_BUILTINS.has(b)).toBe(tier === BuiltinTier.GRAMMAR)
      expect(TOOL_BUILTINS.has(b)).toBe(tier === BuiltinTier.TOOL)
    }
  })

  it('files the words', () => {
    expect(BuiltinGroup.WORKING_DIRECTORY).toBe('working-directory')
    expect(BUILTIN_GROUP.get(ShellBuiltin.CD)).toBe(BuiltinGroup.WORKING_DIRECTORY)
    expect(BUILTIN_GROUP.get(ShellBuiltin.KILL)).toBe(BuiltinGroup.JOB_CONTROL)
    expect(GROUP_TIER.get(BuiltinGroup.JOB_CONTROL)).toBe(BuiltinTier.TOOL)
    expect(GROUP_TIER.get(BuiltinGroup.OUTPUT)).toBe(BuiltinTier.GRAMMAR)
  })
})
