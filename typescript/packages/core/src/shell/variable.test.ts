import { describe, expect, it } from 'vitest'
import { attrLetters, makeVar, VarAttr, varKind, VarKind } from './variable.ts'

describe('attrLetters matches bash 5.2.37 declare -p order', () => {
  const cases: [string, ReturnType<typeof makeVar>][] = [
    ['irx', makeVar('1', new Set([VarAttr.Export, VarAttr.Readonly, VarAttr.Integer]))],
    ['Aiu', makeVar({}, new Set([VarAttr.Integer, VarAttr.Upper]))],
    ['arx', makeVar([], new Set([VarAttr.Readonly, VarAttr.Export]))],
    ['nrx', makeVar('a', new Set([VarAttr.Nameref, VarAttr.Readonly, VarAttr.Export]))],
    ['xl', makeVar('z', new Set([VarAttr.Export, VarAttr.Lower]))],
    ['', makeVar('5')],
  ]
  for (const [want, v] of cases) {
    it(`prints ${want || '(none)'}`, () => {
      expect(attrLetters(v)).toBe(want)
    })
  }
  it('derives kind from the value', () => {
    expect(varKind(makeVar('x'))).toBe(VarKind.Scalar)
    expect(varKind(makeVar([]))).toBe(VarKind.Indexed)
    expect(varKind(makeVar({}))).toBe(VarKind.Assoc)
    expect(varKind(makeVar(null))).toBe(VarKind.Scalar)
  })
})
