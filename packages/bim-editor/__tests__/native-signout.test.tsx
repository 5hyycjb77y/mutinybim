import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { nativeRevocation, NativeSignedOut } from '../demo/native-signout'

function deferredReply() {
  let resolve!: (response: Response) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('native editor sign-out', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('waits for acknowledgement and automatically retries the original credential after a lost reply', async () => {
    const first = deferredReply(), retry = deferredReply()
    const fetcher = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    globalThis.fetch = fetcher
    const confirm = nativeRevocation('fixture-session')
    const signIn = jest.fn()
    render(<StrictMode><NativeSignedOut confirm={confirm} signIn={signIn} /></StrictMode>)

    expect(screen.getByRole('heading', { name: 'Sign-out pending' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Editing stopped in this tab')
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { first.reject(new Error('Reply lost')) })

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('heading', { name: 'Sign-out pending' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry sign-out' })).toBeNull()
    for (const request of fetcher.mock.calls) {
      expect(request).toEqual(['/auth/native/sign-out', expect.objectContaining({
        method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error',
        headers: { Authorization: 'Bearer fixture-session', 'Content-Type': 'application/json' }, body: '{}',
      })])
    }

    await act(async () => { retry.resolve({ status: 204 } as Response) })
    expect(screen.getByRole('heading', { name: 'Signed out' })).toBeVisible()
    await expect(confirm()).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('offers a manual retry when the automatic one also fails', async () => {
    const fetcher = jest.fn().mockRejectedValueOnce(new Error('First reply lost')).mockRejectedValueOnce(new Error('Second reply lost'))
      .mockResolvedValueOnce({ status: 204 })
    globalThis.fetch = fetcher
    render(<NativeSignedOut confirm={nativeRevocation('fixture-session')} signIn={jest.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry sign-out' }))
    expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[2]![1].headers.Authorization).toBe('Bearer fixture-session')
  })
})
