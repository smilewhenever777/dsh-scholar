import React, { useId, useState } from 'react';
import { Input, T } from './ui';

export interface ReferenceOption { id: string; label: string }
/** Names are presentation only; selections always retain the stable source ID. */
export function ReferenceSearch({ label, options, value, onSelect }: {
  label: string; options: ReferenceOption[]; value: string;
  onSelect: (option: ReferenceOption) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const selected = options.find(o => o.id === value);
  const hits = options.filter(o => `${o.label} ${o.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 30);
  return <div style={{ marginBottom: 8 }}>
    <label htmlFor={id} style={{ fontSize: 11, color: T.secondary }}>{label}</label>
    <Input id={id} value={query} placeholder={selected?.label || value || label} aria-controls={id + '-results'} aria-expanded={expanded}
      onFocus={() => setExpanded(true)} onChange={e => { setQuery(e.target.value); setExpanded(true); }} />
    {expanded && <div id={id + '-results'} role="group" aria-label={label} style={{ maxHeight: 130, overflow: 'auto' }}>
      {hits.map(o => <button key={o.id} type="button" onClick={() => { onSelect(o); setQuery(''); setExpanded(false); }}
        style={{ display: 'block', textAlign: 'left', width: '100%', border: 0, padding: 5, background: 'none', color: T.primary, cursor: 'pointer' }}>
        {o.label} <small style={{ color: T.caption }}>({o.id})</small>
      </button>)}
    </div>}
  </div>;
}
