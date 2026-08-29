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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FallbackStorage, asyncContextIsolatesTasks, createAsyncContext } from './async_context.ts'

describe('the resolved storage on node', () => {
  it('isolates two overlapping runs, which is what the flag claims', async () => {
    expect(asyncContextIsolatesTasks).toBe(true)
    const ctx = createAsyncContext<number>()
    const reads = await Promise.all([
      ctx.run(1, async () => {
        await Promise.resolve()
        return ctx.getStore()
      }),
      ctx.run(2, async () => {
        await Promise.resolve()
        return ctx.getStore()
      }),
    ])
    expect(reads).toEqual([1, 2])
  })

  it('liveStores answers the current task alone', async () => {
    const ctx = createAsyncContext<string>()
    expect(ctx.liveStores()).toEqual([])
    await ctx.run('mine', async () => {
      await Promise.resolve()
      expect(ctx.liveStores()).toEqual(['mine'])
    })
    expect(ctx.liveStores()).toEqual([])
  })
})

describe('the fallback frame stack', () => {
  it('nested runs answer innermost and unwind outward', async () => {
    const ctx = new FallbackStorage<string>()
    await ctx.run('outer', async () => {
      expect(ctx.getStore()).toBe('outer')
      await ctx.run('inner', () => {
        expect(ctx.getStore()).toBe('inner')
        expect(ctx.liveStores()).toEqual(['outer', 'inner'])
        return Promise.resolve()
      })
      expect(ctx.getStore()).toBe('outer')
    })
    expect(ctx.getStore()).toBeUndefined()
  })

  it('an out-of-order settle neither wipes a live frame nor strands a stale one', async () => {
    // The single-slot restore this replaces failed both halves: the
    // first-bound run's settle blind-restored its saved value (wiping
    // the still-live second binding to undefined), and the second's
    // settle then restored the first's store into a context where
    // nothing ran any more.
    const ctx = new FallbackStorage<string>()
    let releaseFirst!: () => void
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let seenAfterFirstSettled: string | undefined
    const first = ctx.run('first', async () => {
      await holdFirst
    })
    const second = ctx.run('second', async () => {
      releaseFirst()
      await first
      seenAfterFirstSettled = ctx.getStore()
    })
    await second
    expect(seenAfterFirstSettled).toBe('second')
    expect(ctx.getStore()).toBeUndefined()
    expect(ctx.liveStores()).toEqual([])
  })

  it('a throwing sync fn and a rejecting promise both drop their frames', async () => {
    const ctx = new FallbackStorage<string>()
    expect(() =>
      ctx.run('sync', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(ctx.liveStores()).toEqual([])
    await expect(
      Promise.resolve(ctx.run('async', () => Promise.reject(new Error('boom')))),
    ).rejects.toThrow('boom')
    expect(ctx.liveStores()).toEqual([])
  })

  it('rebinding one value twice releases one frame per settle', async () => {
    const ctx = new FallbackStorage<string>()
    await ctx.run('same', async () => {
      await ctx.run('same', () => {
        expect(ctx.liveStores()).toEqual(['same', 'same'])
        return Promise.resolve()
      })
      expect(ctx.liveStores()).toEqual(['same'])
    })
    expect(ctx.liveStores()).toEqual([])
  })
})

describe('the isolation probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('refuses a non-isolating AsyncLocalStorage polyfill on globalThis', async () => {
    // The bundler-shim shape: right constructor name, single slot. A
    // constructor-identity check would trust it and disarm every
    // fallback hardening; the behavioral probe must not.
    class SlotShim<T> {
      private store: T | undefined

      run<R>(s: T, fn: () => R | Promise<R>): R | Promise<R> {
        const prev = this.store
        this.store = s
        const result = fn()
        if (result instanceof Promise) {
          return result.finally(() => {
            this.store = prev
          })
        }
        this.store = prev
        return result
      }

      getStore(): T | undefined {
        return this.store
      }
    }
    vi.stubGlobal('AsyncLocalStorage', SlotShim)
    vi.resetModules()
    const fresh = await import('./async_context.ts')
    expect(fresh.asyncContextIsolatesTasks).toBe(false)
    expect(fresh.createAsyncContext()).toBeInstanceOf(fresh.FallbackStorage)
  })

  it('refuses a polyfill that throws', async () => {
    class ThrowingShim {
      run(): never {
        throw new Error('not implemented')
      }

      getStore(): never {
        throw new Error('not implemented')
      }
    }
    vi.stubGlobal('AsyncLocalStorage', ThrowingShim)
    vi.resetModules()
    const fresh = await import('./async_context.ts')
    expect(fresh.asyncContextIsolatesTasks).toBe(false)
    expect(fresh.createAsyncContext()).toBeInstanceOf(fresh.FallbackStorage)
  })
})
