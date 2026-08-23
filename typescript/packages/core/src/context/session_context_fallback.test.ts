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

import { describe, expect, it, vi } from 'vitest'
import {
  mountGateFor,
  requireMountWritable,
  runWithMountGate,
  runWithSession,
} from './session_context.ts'
import { MountMode } from '../types.ts'
import { Session } from '../workspace/session/session.ts'

// The browser-runtime branch under node's test runner: the mocked
// module is the real FallbackStorage shape (one global slot restored
// when run's promise settles, no task isolation), so these tests pin
// what the mount gate does where AsyncLocalStorage does not exist.
vi.mock('../utils/async_context.ts', () => {
  class SlotStorage<T> {
    private store: T | undefined

    run<R>(s: T, fn: () => R | Promise<R>): R | Promise<R> {
      const prev = this.store
      this.store = s
      try {
        const result = fn()
        if (result instanceof Promise) {
          return result.finally(() => {
            this.store = prev
          })
        }
        this.store = prev
        return result
      } catch (err) {
        this.store = prev
        throw err
      }
    }

    getStore(): T | undefined {
      return this.store
    }
  }
  return {
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>(): SlotStorage<T> {
      return new SlotStorage<T>()
    },
  }
})

describe('the mount gate on the fallback storage', () => {
  it('overlapping commands each answer with their own mounts gate', async () => {
    // The corruption the slot would allow: while B runs, a slot read in
    // A's continuation sees B's gate, and A's protected path is judged
    // with B's prefix and mode. The live list answers by the path.
    let releaseA!: () => void
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let releaseB!: () => void
    const holdB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let gateInA: readonly [string, MountMode] | null = null
    let gateInB: readonly [string, MountMode] | null = null
    const cmdA = runWithMountGate('/a', MountMode.WRITE, async () => {
      await holdA
      // B is still mid-run here: both gates are live.
      gateInA = mountGateFor('/a/data.txt')
      releaseB()
    })
    const cmdB = runWithMountGate('/b', MountMode.WRITE, async () => {
      gateInB = mountGateFor('/b/y')
      releaseA()
      await holdB
    })
    await Promise.all([cmdA, cmdB])
    expect(gateInA).toEqual(['/a', MountMode.WRITE])
    expect(gateInB).toEqual(['/b', MountMode.WRITE])
    // Both runs settled, so both gates released.
    expect(mountGateFor('/a/data.txt')).toBeNull()
    expect(mountGateFor('/b/y')).toBeNull()
  })

  it('the longest covering prefix wins and a tie takes the weaker mode', async () => {
    await runWithMountGate('/repo', MountMode.WRITE, () =>
      runWithMountGate('/repo/sub', MountMode.READ, () => {
        // The way the mount table routes: the deeper mount serves the
        // deeper path.
        expect(mountGateFor('/repo/sub/x')).toEqual(['/repo/sub', MountMode.READ])
        expect(mountGateFor('/repo/y')).toEqual(['/repo', MountMode.WRITE])
        expect(mountGateFor('/elsewhere')).toBeNull()
        return Promise.resolve()
      }),
    )
    await runWithMountGate('/data', MountMode.WRITE, () =>
      runWithMountGate('/data', MountMode.READ, () => {
        // Two workspaces sharing a fallback runtime with one prefix:
        // the reader cannot tell whose gate this is, so it answers
        // with the weaker mode.
        expect(mountGateFor('/data/x')).toEqual(['/data', MountMode.READ])
        return Promise.resolve()
      }),
    )
  })

  it('a failed run still releases its gate', async () => {
    await expect(
      runWithMountGate('/a', MountMode.WRITE, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    expect(mountGateFor('/a/x')).toBeNull()
  })

  it('requireMountWritable answers for the named mount, not a concurrent one', async () => {
    const sess = new Session({
      sessionId: 'agent',
      mountModes: new Map([['/trello', MountMode.READ]]),
    })
    await runWithSession(sess, () =>
      runWithMountGate('/s3', MountMode.WRITE, () =>
        runWithMountGate('/trello', MountMode.WRITE, () => {
          // Both gates live: the id-addressed trello write is judged by
          // trello's own gate even with s3's writable one beside it.
          expect(() => {
            requireMountWritable('/trello')
          }).toThrowError(/read-only/)
          requireMountWritable('/s3')
          return Promise.resolve()
        }),
      ),
    )
  })
})
