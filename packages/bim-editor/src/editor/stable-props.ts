'use client'

import { useRef } from 'react'

type AnyFn = (...args: never[]) => unknown

/**
 * Props for a memoised panel whose parent still re-renders on every model
 * edit: each top-level function becomes a stable trampoline that calls the
 * latest one, so a new closure alone does not re-render the panel, and a call
 * never runs a stale closure. The latest props are taken during the parent's
 * render, so a child rendering in the same pass already sees them.
 */
export function useStableHandlers<P extends object>(props: P): P {
  const latest = useRef(props)
  latest.current = props
  const trampolines = useRef(new Map<keyof P, AnyFn>())
  const out: Partial<P> = {}
  for (const key of Object.keys(props) as (keyof P)[]) {
    const value = props[key]
    if (typeof value !== 'function') {
      out[key] = value
      continue
    }
    let fn = trampolines.current.get(key)
    if (!fn) {
      fn = (...args: never[]) => {
        const current = latest.current[key]
        return typeof current === 'function' ? (current as AnyFn)(...args) : undefined
      }
      trampolines.current.set(key, fn)
    }
    out[key] = fn as P[keyof P]
  }
  return out as P
}

/**
 * `React.memo` comparator for `useStableHandlers` props: functions are equal
 * (they are trampolines), arrays are equal when their items are, everything
 * else by identity. Objects are NOT compared inside, so a group of props that
 * is rebuilt each render (a side panel that is open) re-renders as before.
 */
export function stablePropsEqual<P extends object>(a: P, b: P): boolean {
  const keys = Object.keys(a) as (keyof P)[]
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (Object.is(x, y)) continue
    if (typeof x === 'function' && typeof y === 'function') continue
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, i) => Object.is(item, y[i]))) continue
    return false
  }
  return true
}
