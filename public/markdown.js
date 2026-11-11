// A deliberately small Markdown renderer. Raw HTML is always text; images never load.
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inline(text, depth = 0) {
  if (depth > 4) return escapeHTML(text);
  const tokens = /`([^`\n]+)`|!?\[([^\]\n]*)\]\(([^\s)]+)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^\n]+?)~~/g;
  let out = '', end = 0;
  for (const match of text.matchAll(tokens)) {
    out += escapeHTML(text.slice(end, match.index));
    if (match[1] !== undefined) out += '<code>' + escapeHTML(match[1]) + '</code>';
    else if (match[2] !== undefined) {
      let url;
      try { const parsed = new URL(match[3]); if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href; } catch {}
      const label = inline(match[2], depth + 1);
      out += url && !match[0].startsWith('!') ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    } else if (match[4] !== undefined || match[5] !== undefined) out += '<strong>' + inline((match[4] ?? match[5]).trim(), depth + 1) + '</strong>';
    else if (match[6] !== undefined || match[7] !== undefined) out += '<em>' + inline(match[6] ?? match[7], depth + 1) + '</em>';
    else out += '<del>' + inline(match[8], depth + 1) + '</del>';
    end = match.index + match[0].length;
  }
  return out + escapeHTML(text.slice(end));
}
const listLine = line => /^(\s*)(?:(\d+)[.)]|([-+*]))\s+(.*)$/.exec(line);
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const tableRule = line => line && line.includes('|') && cells(line).every(c => /^:?-{3,}:?$/.test(c));
const blockStart = line => /^\s*(#{1,6}\s|>|`{3,}|~{3,}|(?:[-*_]\s*){3,}$)/.test(line) || listLine(line);
function blocks(lines, depth = 0) {
  if (depth > 12) return '<p>' + inline(lines.join('\n')).replace(/\n/g, '<br>') + '</p>';
  let out = '', i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      out += '<pre><code>' + escapeHTML(body.join('\n')) + '</code></pre>'; continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out += '<hr>'; i++; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { const level = Math.min(heading[1].length + 2, 6); out += `<h${level}>${inline(heading[2])}</h${level}>`; i++; continue; }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ''));
      out += '<blockquote>' + blocks(quoted, depth + 1) + '</blockquote>'; continue;
    }
    if (line.includes('|') && tableRule(lines[i + 1])) {
      const headings = cells(line); i += 2;
      let body = '';
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = cells(lines[i++]);
        body += '<tr>' + headings.map((_, n) => '<td>' + inline(row[n] || '') + '</td>').join('') + '</tr>';
      }
      out += '<div class="markdown-table" role="region" aria-label="营养师回复表格" tabindex="0"><table><thead><tr>' + headings.map(h => '<th scope="col">' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>'; continue;
    }
    const first = listLine(line);
    if (first) {
      const indent = first[1].length, ordered = first[2] !== undefined, tag = ordered ? 'ol' : 'ul';
      out += '<' + tag + (ordered ? ` start="${Math.min(10000, Math.max(1, Number(first[2])))}"` : '') + '>';
      while (i < lines.length) {
        const item = listLine(lines[i]);
        if (!item || item[1].length !== indent || (item[2] !== undefined) !== ordered) break;
        const content = [item[4]]; i++;
        while (i < lines.length) {
          const next = lines[i], entry = listLine(next);
          if (!next.trim()) {
            if (lines[i + 1] && /^\s*/.exec(lines[i + 1])[0].length > indent) { content.push(''); i++; continue; }
            break;
          }
          const space = /^\s*/.exec(next)[0].length;
          if (entry && space <= indent || !entry && space <= indent) break;
          content.push(next.slice(Math.min(space, indent + 2))); i++;
        }
        out += '<li>' + blocks(content, depth + 1) + '</li>';
      }
      out += '</' + tag + '>'; continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i]) && !(lines[i].includes('|') && tableRule(lines[i + 1]))) paragraph.push(lines[i++]);
    out += '<p>' + inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>';
  }
  return out;
}
export function renderMarkdown(value) { return blocks(String(value ?? '').replace(/\r\n?/g, '\n').split('\n')); }
