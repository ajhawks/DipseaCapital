import { useState } from 'react';
import VoiceOrderPanel from './components/VoiceOrderPanel.tsx';
import { MicIcon } from './components/icons.tsx';

const STORAGE_KEY = 'silexx_jwt';

function BrandMark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span
      className={[
        'flex items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-700',
        'text-white shadow-lg shadow-blue-600/30',
        size === 'lg' ? 'h-12 w-12' : 'h-9 w-9',
      ].join(' ')}
    >
      <MicIcon className={size === 'lg' ? 'h-6 w-6' : 'h-5 w-5'} />
    </span>
  );
}

export default function App() {
  const [token, setToken] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? '',
  );

  function handleTokenSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const t = String(data.get('token') ?? '').trim();
    if (t) {
      localStorage.setItem(STORAGE_KEY, t);
      setToken(t);
    }
  }

  function handleSignOut() {
    localStorage.removeItem(STORAGE_KEY);
    setToken('');
  }

  if (!token) {
    return (
      <div
        className="min-h-screen antialiased flex items-center justify-center p-4
                   bg-gradient-to-b from-slate-100 via-slate-50 to-blue-50"
      >
        <form
          onSubmit={handleTokenSubmit}
          className="w-full max-w-sm space-y-5 rounded-2xl bg-white p-8 shadow-card
                     ring-1 ring-slate-900/5 animate-fade-up motion-reduce:animate-none"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <BrandMark size="lg" />
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Silexx Voice Order Entry
            </h1>
            <p className="text-sm leading-relaxed text-slate-500">
              Speak an order, review it, and create a draft ticket in Silexx. Orders are never
              submitted automatically.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="token" className="block text-sm font-medium text-slate-700">
              JWT token
            </label>
            <input
              id="token"
              name="token"
              type="password"
              required
              autoComplete="off"
              placeholder="Bearer token"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm
                         shadow-sm transition-shadow focus:outline-none focus:ring-2
                         focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-2.5
                       text-sm font-semibold text-white shadow-md shadow-blue-600/25
                       transition hover:from-blue-600 hover:to-blue-700 active:scale-[0.99]
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Continue
          </button>
        </form>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen antialiased
                 bg-gradient-to-b from-slate-100 via-slate-50 to-blue-50"
    >
      <header className="sticky top-0 z-10 bg-slate-900 shadow-md">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div>
              <h1 className="text-base font-bold leading-tight tracking-tight text-white">
                Silexx Voice Order Entry
              </h1>
              <p className="text-xs text-slate-400">
                Drafts only — orders are never submitted automatically
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-300
                       transition-colors hover:bg-slate-800 hover:text-white
                       focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="px-6 py-10">
        <VoiceOrderPanel token={token} />
      </main>
    </div>
  );
}
