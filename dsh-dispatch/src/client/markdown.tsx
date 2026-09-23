/**
 * 安全轻量 markdown 渲染(Wave 3):Agent 消息的受限格式化。
 * 解析为 React 元素(不经 innerHTML),只支持:段落/粗体/斜体/行内代码/
 * 代码块/无序列表/有序列表/引用/二级三级标题;链接仅显示文本不可点(§8.4)。
 */
import React from 'react';

type Seg = { t: 'text' | 'bold' | 'italic' | 'code'; v: string };

/** 行内解析:**bold**、*italic*、\`code\`;其余纯文本(自动转义由 React 保证)。 */
function inlineSegments(line: string): Seg[] {
  const segs: Seg[] = [];
  let rest = line;
  const push = (t: Seg['t'], v: string) => { if (v) segs.push({ t, v }); };
  while (rest) {
    const code = rest.indexOf('`');
    const bold = rest.indexOf('**');
    const ital = rest.replace(/[*][*]/g, '\u0000').indexOf('*');
    const candidates = [code, bold, ital].filter((i) => i >= 0);
    if (!candidates.length) { push('text', rest); break; }
    const at = Math.min(...candidates);
    if (at > 0) push('text', rest.slice(0, at));
    if (at === code) {
      const end = rest.indexOf('`', at + 1);
      if (end < 0) { push('text', rest.slice(at)); break; }
      push('code', rest.slice(at + 1, end));
      rest = rest.slice(end + 1);
    } else if (at === bold) {
      const end = rest.indexOf('**', at + 2);
      if (end < 0) { push('text', rest.slice(at)); break; }
      push('bold', rest.slice(at + 2, end));
      rest = rest.slice(end + 2);
    } else {
      const end = rest.indexOf('*', at + 1);
      if (end < 0) { push('text', rest.slice(at)); break; }
      push('italic', rest.slice(at + 1, end));
      rest = rest.slice(end + 1);
    }
  }
  return segs;
}

function renderInline(line: string, keyPrefix: string): React.ReactNode[] {
  return inlineSegments(line).map((seg, i) => {
    const key = `${keyPrefix}-${i}`;
    if (seg.t === 'bold') return <strong key={key}>{seg.v}</strong>;
    if (seg.t === 'italic') return <em key={key} className="dsp-md-em">{seg.v}</em>;
    if (seg.t === 'code') return <code key={key} className="dsp-md-code">{seg.v}</code>;
    return <React.Fragment key={key}>{seg.v}</React.Fragment>;
  });
}

/** 块级解析:代码块围栏、标题、列表、引用、段落。 */
export function renderMarkdown(text: string): React.ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `md-${key++}`;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // 跳过闭合围栏(或到结尾)
      blocks.push(<pre key={k()} className="dsp-md-pre">{buf.join('\n')}</pre>);
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const content = line.replace(/^#+\s+/, '');
      blocks.push(<div key={k()} className={`dsp-md-h${Math.min(3, level)}`}>{renderInline(content, `h${key}`)}</div>);
      i++;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*•]\s+/, '')); i++; }
      blocks.push(<ul key={k()} className="dsp-md-list">{items.map((item, j) => <li key={j}>{renderInline(item, `li${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      blocks.push(<ol key={k()} className="dsp-md-list">{items.map((item, j) => <li key={j}>{renderInline(item, `ol${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push(<blockquote key={k()} className="dsp-md-quote">{renderMarkdown(buf.join('\n'))}</blockquote>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // 段落:连续非空行合并
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !/^#{1,3}\s+/.test(lines[i])
      && !/^\s*[-*•]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
    blocks.push(<p key={k()} className="dsp-md-p">{renderInline(buf.join('\n'), `p${key}`)}</p>);
  }
  return <>{blocks}</>;
}

export const markdownCss = `
.dsp-md-p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.dsp-md-p:last-child { margin-bottom: 0; }
.dsp-md-em { opacity: .85; }
.dsp-md-code { font: 11px/1.5 ui-monospace, Consolas, monospace; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, white 8%, transparent); border: 1px solid color-mix(in srgb, white 8%, transparent); }
.dsp-md-pre { margin: 6px 0 10px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, black 18%, transparent); font: 11px/1.6 ui-monospace, Consolas, monospace; overflow: auto; max-height: 380px; white-space: pre; }
.dsp-md-h1,.dsp-md-h2,.dsp-md-h3 { font-weight: 700; margin: 10px 0 6px; }
.dsp-md-h1 { font-size: 14px; } .dsp-md-h2 { font-size: 13px; } .dsp-md-h3 { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsp-md-list { margin: 2px 0 8px; padding-left: 20px; }
.dsp-md-list li { margin: 3px 0; line-height: 1.65; }
.dsp-md-quote { margin: 4px 0 8px; padding: 6px 12px; border-left: 3px solid color-mix(in srgb, var(--dsp-accent, #4d6bfe) 45%, transparent); background: color-mix(in srgb, var(--dsp-accent, #4d6bfe) 5%, transparent); border-radius: 0 6px 6px 0; }
.dsp-md-quote > *:last-child { margin-bottom: 0; }
`;
