import React from 'react';

/** Local, host-themed UI: no fonts, images or other resources are fetched. */
export const workbenchCss = `
  .dshwb-surface, .dshwb-menu, .dshwb-empty {
    --wb-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
    --wb-base: var(--dsw-alias-bg-base, #fff);
    --wb-soft: color-mix(in srgb, var(--dsw-alias-label-primary, #202329) 3%, var(--wb-base));
    --wb-border: var(--dsw-alias-border-l2, #e3e5e9);
    --wb-radius: 10px;
    color: var(--dsw-alias-label-primary, #202329);
    font-size: 12px; line-height: 1.55;
  }
  .dshwb-surface { background: var(--wb-base); container-type: inline-size; }
  .dshwb-surface :where(button, input, textarea, select) { font-family: inherit; }
  .dshwb-surface :where(button, a, input, textarea, select, [tabindex]):focus-visible,
  .dshwb-menu button:focus-visible {
    outline: 2px solid var(--wb-accent); outline-offset: 2px;
  }
  .dshwb-surface :where(input, textarea, select):disabled { cursor: not-allowed; opacity: .55; }
  .dshwb-header {
    display: flex; align-items: center; gap: 8px; flex: none; min-width: 0;
    min-height: 46px; box-sizing: border-box; padding: 8px 10px;
    border-bottom: 1px solid var(--wb-border); background: var(--wb-base);
  }
  .dshwb-header-icon {
    width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    flex: none; border: 1px solid color-mix(in srgb, var(--wb-accent) 15%, transparent);
    border-radius: 8px; color: var(--wb-accent);
    background: color-mix(in srgb, var(--wb-accent) 7%, transparent);
  }
  .dshwb-heading { flex: 1; min-width: 0; font-size: 13px; font-weight: 650; letter-spacing: .015em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dshwb-count { flex: none; min-width: 0; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); background: var(--wb-soft); padding: 1px 6px; border-radius: 5px; }
  .dshwb-actions { display: flex; align-items: center; gap: 2px; flex: none; }
  .dshwb-toolbar { background: var(--wb-base); border-bottom: 1px solid var(--wb-border); margin-bottom: 10px; }
  .dshwb-nav { background: var(--wb-soft) !important; }
  .dshwb-nav button[aria-current="page"] { box-shadow: inset 2px 0 var(--wb-accent) !important; }
  .dshwb-card { min-width: 0; background: var(--wb-base) !important; border-radius: var(--wb-radius) !important; }
  .dshwb-card:hover { box-shadow: 0 2px 10px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
  .dshwb-settings { box-sizing: border-box; width: 100%; max-width: 680px; padding: 20px 24px; }
  .dshwb-settings :where(input:not([type="checkbox"]), textarea, select) { min-height: 30px; box-sizing: border-box; border-radius: 8px; }
  .dshwb-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 190px; padding: 32px 18px; box-sizing: border-box; text-align: center; }
  .dshwb-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 16px; color: var(--wb-accent); border: 1px solid color-mix(in srgb, var(--wb-accent) 14%, var(--wb-border)); background: color-mix(in srgb, var(--wb-accent) 5%, var(--wb-base)); margin-bottom: 4px; }
  .dshwb-empty-icon svg { width: 26px; height: 26px; }
  .dshwb-empty-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
  .dshwb-empty-hint { max-width: 280px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.75; overflow-wrap: anywhere; }
  .dshwb-empty-action { margin-top: 4px; }
  .dshwb-surface .dshwb-button { min-height: 30px; border-radius: 8px; }
  .dshwb-surface .dshwb-button[data-tone="primary"] { color: #fff !important; background: var(--wb-accent) !important; border-color: transparent !important; }
  .dshwb-surface .dshwb-button:hover:not(:disabled) { filter: brightness(.97); }
  .dshwb-surface :is(.sch-input, .traj-input) { min-height: 30px; border-radius: 8px; background: var(--wb-base); }
  .dshwb-surface :is(.sch-card, .traj-card):hover { transform: none; }
  .dshwb-surface [data-dsh-part="collection-rail"] { background: var(--wb-soft); }
  .dshwb-surface [data-dsh-part="rail-item"][aria-current="page"] { color: var(--wb-accent); background: color-mix(in srgb, var(--wb-accent) 9%, transparent); }
  .dshwb-surface [data-dsh-part="rail-item"] { min-height: 32px; }
  .dshwb-surface [data-dsh-part="paper-card"] { margin-bottom: 8px; }
  .dshwb-toolbar > * { max-width: 100%; box-sizing: border-box; }
  .dshwb-paper-title { min-width: 0; }
  .dshwb-surface .dshwb-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--dsw-alias-label-caption) 38%, transparent) transparent; }
  @container (max-width: 380px) {
    .dshwb-header .dshwb-count { display: none; }
    .dshwb-paper-heading { flex-wrap: wrap; }
    .dshwb-paper-title { flex-basis: 100% !important; }
  }
  @container (max-width: 460px) {
    .dshwb-surface [data-dsh-part="collection-rail"] { width: 120px !important; }
    .dshwb-surface .dshwb-library-search { flex-basis: calc(100% - 34px) !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dshwb-surface, .dshwb-surface *, .dshwb-surface *::before, .dshwb-surface *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;

export function WorkbenchStyles() { return <style data-dsh-workbench-styles>{workbenchCss}</style>; }

export function PanelHeader({ icon, title, count, children, ...props }: {
  icon: React.ReactNode; title: string; count?: React.ReactNode; children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`dshwb-header ${props.className ?? ''}`} data-dsh-part="panel-header">
    <span className="dshwb-header-icon" aria-hidden>{icon}</span>
    <span className="dshwb-heading" title={title}>{title}</span>
    {count !== undefined && count !== null && <span className="dshwb-count">{count}</span>}
    <span className="dshwb-actions">{children}</span>
  </div>;
}

export function WorkbenchEmpty({ icon, title, hint, action }: {
  icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode;
}) {
  return <div className="dshwb-empty">
    <span className="dshwb-empty-icon" aria-hidden>{icon}</span>
    <div className="dshwb-empty-title">{title}</div>
    {hint && <div className="dshwb-empty-hint">{hint}</div>}
    {action && <div className="dshwb-empty-action">{action}</div>}
  </div>;
}
