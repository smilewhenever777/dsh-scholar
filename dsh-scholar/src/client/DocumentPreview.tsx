import React, { useEffect, useState } from 'react';
import { isDesktop } from '../../../shared-client/src/desktop';
import { Modal } from './ui';

const PREVIEW_EVENT = 'dsh-scholar-document-preview';
const DOCUMENT_PATH = /^\/scholar\/papers\/[^/]+\/(?:pdf|reports\/[^/]+\.html)$/;

/** Desktop denies new application windows. Keep authenticated documents in the owned renderer. */
export function installDocumentPreview(): () => void {
  const click = (event: MouseEvent) => {
    if (!isDesktop() || event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[target="_blank"]');
    if (!anchor || anchor.hasAttribute('download')) return;
    let url: URL;
    try { url = new URL(anchor.href, window.location.href); }
    catch { return; }
    if (url.protocol !== window.location.protocol || url.host !== window.location.host || !DOCUMENT_PATH.test(url.pathname)) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: { path: url.pathname, title: anchor.title || anchor.textContent?.trim() || 'PDF' } }));
  };
  document.addEventListener('click', click, true);
  return () => document.removeEventListener('click', click, true);
}

export function DocumentPreview() {
  const [document, setDocument] = useState<{ path: string; title: string } | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (typeof value?.path === 'string' && DOCUMENT_PATH.test(value.path)) setDocument(value);
    };
    window.addEventListener(PREVIEW_EVENT, open);
    return () => window.removeEventListener(PREVIEW_EVENT, open);
  }, []);
  if (!document) return null;
  return <Modal title={document.title} width={1000} onClose={() => setDocument(null)}>
    <iframe src={document.path} title={document.title} style={{ width: '100%', height: '72vh', border: 0, background: '#fff' }} />
  </Modal>;
}
