import React, { useEffect, useState } from 'react';

export function App(): React.ReactElement {
  const [message, setMessage] = useState<string>('Loading…');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch('/api/greeting')
      .then((r) => r.json())
      .then((d) => setMessage(d.message))
      .catch(() => setMessage('Hello'));
  }, []);

  async function save(): Promise<void> {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/greeting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: draft.trim() }),
      });
      const d = await res.json();
      setMessage(d.message);
      setDraft('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: 560,
      margin: '60px auto',
      padding: 24,
      color: '#222',
    }}>
      <h1 style={{ fontSize: 36, marginBottom: 8 }}>__APP_NAME__</h1>
      <p style={{ color: '#666', marginBottom: 32 }}>
        Edit this page by telling Sprout what you'd like to change.
      </p>

      <div style={{
        padding: 20,
        background: '#fafaf7',
        border: '1px solid #e3e0d6',
        borderRadius: 8,
      }}>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: '#888', marginBottom: 6 }}>
          Saved greeting
        </div>
        <div style={{ fontSize: 22, marginBottom: 16 }}>{message}</div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            placeholder="Change the greeting…"
            style={{
              flex: 1,
              padding: '8px 10px',
              border: '1px solid #d0ccbf',
              borderRadius: 6,
              fontSize: 14,
            }}
          />
          <button
            onClick={() => void save()}
            disabled={!draft.trim() || saving}
            style={{
              padding: '8px 16px',
              background: '#b85c2e',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
