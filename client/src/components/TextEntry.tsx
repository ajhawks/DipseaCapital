import { useState } from 'react';

/** Manual order entry. Goes through the same /api/parse pipeline and review flow as voice. */
export default function TextEntry({ disabled, onSubmit }: { disabled: boolean; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      aria-label="Type an order"
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          onSubmit(text.trim());
          setText('');
        }
      }}
    >
      <label htmlFor="order-text" className="sr-only">
        Order text
      </label>
      <input
        id="order-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Or type it: buy 100 AAPL at 195.50"
        autoComplete="off"
        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:opacity-50"
      >
        Draft it
      </button>
    </form>
  );
}
