const $ = s => document.querySelector(s);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let chats = store.get('alpha.chats', []);
let outbox = store.get('alpha.outbox', []);
let settings = { key: '', system: '', model: '', mode: 'ask', theme: 'dark', ...store.get('alpha.settings', {}) };
let cur = null, busy = null, agentAllowed = true, raf = 0;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const save = () => { store.set('alpha.chats', chats); store.set('alpha.outbox', outbox); store.set('alpha.settings', settings); };
const hdr = () => ({ 'Content-Type': 'application/json', 'x-alpha-key': settings.key });
const fileUrl = p => `/api/files/${p.split('/').map(encodeURIComponent).join('/')}?key=${encodeURIComponent(settings.key)}`;
const flat = m => m.role === 'user' ? m.content
  : m.blocks.filter(b => b.t === 'text').map(b => b.v).join('\n') +
    (m.blocks.some(b => b.file) ? '\n[Files created: ' + m.blocks.filter(b => b.file).map(b => b.file).join(', ') + ']' : '');

/* ---------- markdown ---------- */
function md(src) {
  const codes = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, l, c) => { codes.push({ l, c }); return `\u0000${codes.length - 1}\u0000`; });
  let h = esc(src)
    .replace(/^(#{1,4})\s+(.+)$/gm, (_, a, t) => `<h${a.length + 1}>${t}</h${a.length + 1}>`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^(?:[-*]\s.+(?:\n|$))+/gm, m => '<ul>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^[-*]\s/, '') + '</li>').join('') + '</ul>')
    .replace(/^(?:\d+\.\s.+(?:\n|$))+/gm, m => '<ol>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^\d+\.\s/, '') + '</li>').join('') + '</ol>');
  h = h.split(/\n{2,}/).map(p => /^(<(h\d|ul|ol)|\u0000)/.test(p.trim()) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const { l, c } = codes[i];
    return `<div class="code"><div class="code-h"><span>${esc(l || 'text')}</span><button type="button" data-copy>Copy</button></div><pre><code>${esc(c.replace(/\n$/, ''))}</code></pre></div>`;
  });
}

/* ---------- rendering ---------- */
function blockHtml(b) {
  if (b.t === 'text') return md(b.v);
  if (b.t === 'error') return `<div class="err">${esc(b.v)}</div>`;
  const a = b.args || {};
  const title = b.name === 'run_command' ? '$ ' + esc(a.command || '') : b.name === 'write_file' ? 'Write ' + esc(a.path || '')
    : b.name === 'read_file' ? 'Read ' + esc(a.path || '') : 'List files';
  const label = { run: 'running', approve: 'needs approval', done: 'done', denied: 'denied' }[b.state] || '';
  const act = b.state === 'approve'
    ? `<div class="act"><button class="primary" data-approve="${b.id}" data-allow="1">Run command</button><button data-approve="${b.id}" data-allow="0">Deny</button></div>` : '';
  const out = b.output ? `<pre>${esc(b.output)}</pre>` : '';
  const file = b.file ? `<a class="file" href="${fileUrl(b.file)}" download>Download ${esc(b.file)}</a>` : '';
  return `<details class="tool ${b.state}" ${b.state !== 'done' ? 'open' : ''}><summary><b>${title}</b><em>${label}</em></summary>${act}${out}${file}</details>`;
}
function msgEl(m, live) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  if (m.role === 'user') { d.innerHTML = `<div class="bubble">${esc(m.content)}</div>`; return d; }
  fillAssistant(d, m, live);
  return d;
}
function fillAssistant(d, m, live) {
  d.innerHTML = `<div class="av">α</div><div class="body">${m.notice ? `<div class="chip">${esc(m.notice)}</div>` : ''}${m.blocks.map(blockHtml).join('')}` +
    (m.queued ? '<div class="chip">Queued. Alpha will send this when you are back online.</div>' : '') +
    (live && !m.blocks.length ? '<span class="dots"></span>' : '') + '</div>';
}
function renderAll() {
  const box = $('#msgs');
  box.innerHTML = '';
  if (!cur || !cur.msgs.length) {
    box.innerHTML = `<div class="empty"><div class="hero">α</div><h1>What should we work on?</h1><p>Ask anything, or let Alpha write files and run commands for you.</p>
      <div class="sugg">${['Build a landing page and give me the files', 'Write a Python script that renames photos by date, then test it', 'Explain how transformers work, simply', 'Create a CSV of 20 sample customers'].map(s => `<button type="button" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
  } else {
    const w = document.createElement('div'); w.className = 'wrap';
    cur.msgs.forEach((m, i) => w.append(msgEl(m, busy && i === cur.msgs.length - 1)));
    box.append(w);
    box.scrollTop = box.scrollHeight;
  }
  renderList();
}
function renderLive() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const els = document.querySelectorAll('#msgs .msg.assistant');
    const el = els[els.length - 1], m = cur?.msgs.at(-1);
    if (!el || !m) return;
    const box = $('#msgs'), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    fillAssistant(el, m, !!busy);
    if (stick) box.scrollTop = box.scrollHeight;
  });
}
function renderList() {
  const q = $('#search').value.toLowerCase();
  $('#list').innerHTML = chats.filter(c => c.title.toLowerCase().includes(q)).sort((a, b) => b.ts - a.ts)
    .map(c => `<div class="item ${c === cur ? 'on' : ''}" data-id="${c.id}"><span>${esc(c.title)}</span><button data-del="${c.id}" aria-label="Delete chat">×</button></div>`).join('');
}

/* ---------- chat flow ---------- */
function newChat() {
  cur = { id: crypto.randomUUID(), title: 'New chat', ts: Date.now(), msgs: [] };
  chats.push(cur); return cur;
}
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  const c = cur || newChat();
  c.msgs.push({ role: 'user', content: text });
  if (c.msgs.length === 1) c.title = text.slice(0, 50);
  const a = { role: 'assistant', blocks: [] };
  c.msgs.push(a); c.ts = Date.now();
  $('#input').value = ''; resize();
  if (!navigator.onLine) { a.queued = true; outbox.push(c.id); save(); renderAll(); return; }
  save(); renderAll();
  run(c, a);
}
async function run(c, a) {
  a.queued = false; a.blocks = []; a.notice = '';
  busy = new AbortController(); setBusy(true); renderAll();
  const history = c.msgs.slice(0, c.msgs.indexOf(a)).map(m => ({ role: m.role, content: flat(m) })).filter(m => m.content);
  const lastText = () => {
    let b = a.blocks.at(-1);
    if (!b || b.t !== 'text') { b = { t: 'text', v: '' }; a.blocks.push(b); }
    return b;
  };
  const tool = id => a.blocks.find(b => b.t === 'tool' && b.id === id);
  const on = e => {
    if (e.type === 'text') lastText().v += e.text;
    else if (e.type === 'reset') { const b = a.blocks.at(-1); if (b?.t === 'text') b.v = ''; }
    else if (e.type === 'notice') a.notice = e.message;
    else if (e.type === 'tool') a.blocks.push({ t: 'tool', id: e.id, name: e.name, args: e.args, state: 'run' });
    else if (e.type === 'approval') { const b = tool(e.id); if (b) b.state = 'approve'; }
    else if (e.type === 'tool_result') { const b = tool(e.id); if (b) { b.output = e.output; b.file = e.file; b.state = e.output.startsWith('The user denied') ? 'denied' : 'done'; } }
    else if (e.type === 'error') a.blocks.push({ t: 'error', v: e.message });
    renderLive();
  };
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: busy.signal, headers: hdr(),
      body: JSON.stringify({ messages: history, model: $('#model').value.trim() || undefined, mode: $('#mode').value, system: settings.system }),
    });
    if (r.status === 401) { $('#settings').showModal(); throw new Error('Access key needed. Enter it in Settings.'); }
    if (!r.ok) throw new Error('Server error ' + r.status);
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data:')) try { on(JSON.parse(line.slice(5))); } catch {}
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') { if (!a.blocks.length) a.blocks.push({ t: 'text', v: '_Stopped._' }); }
    else a.blocks.push({ t: 'error', v: navigator.onLine ? e.message : 'You are offline. Your chats are still here.' });
  } finally {
    a.blocks.forEach(b => { if (b.t === 'tool' && (b.state === 'run' || b.state === 'approve')) b.state = 'denied'; });
    busy = null; setBusy(false); save(); renderAll();
  }
}
function setBusy(b) {
  const s = $('#send'); s.textContent = b ? 'Stop' : 'Send'; s.type = b ? 'button' : 'submit';
}
async function flushOutbox() {
  const ids = [...new Set(outbox)]; outbox = []; save();
  for (const id of ids) {
    const c = chats.find(x => x.id === id), a = c?.msgs.at(-1);
    if (a?.queued) { cur = c; await run(c, a); }
  }
}

/* ---------- files, settings, misc ---------- */
async function loadFiles() {
  try {
    const list = await (await fetch('/api/files', { headers: hdr() })).json();
    $('#files').innerHTML = list.length ? list.map(f => `<div class="f"><a href="${fileUrl(f.path)}" download>${esc(f.path)}</a><small>${f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B'}</small><button data-rm="${esc(f.path)}" aria-label="Delete file">×</button></div>`).join('')
      : '<p class="mute">Nothing yet. Ask Alpha to create a file.</p>';
  } catch { $('#files').innerHTML = '<p class="mute">Files are unavailable offline.</p>'; }
}
async function loadModels() {
  let list = store.get('alpha.models', []);
  try {
    const cfg = await (await fetch('/api/config', { headers: hdr() })).json();
    agentAllowed = cfg.agentAllowed;
    if (!$('#model').value) $('#model').value = cfg.defaultModel;
    list = await (await fetch('/api/models', { headers: hdr() })).json();
    store.set('alpha.models', list);
  } catch {}
  $('#models').innerHTML = list.map(m => `<option value="${esc(m.id)}">${m.free ? 'free' : ''}</option>`).join('');
  if (!agentAllowed) { $('#mode').value = 'off'; [...$('#mode').options].forEach(o => o.disabled = o.value !== 'off'); }
}
function net() {
  $('#net').className = 'net' + (navigator.onLine ? '' : ' off');
  $('#net').title = navigator.onLine ? 'Online' : 'Offline: chats are saved, messages will queue';
}
function resize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'dark' ? '#15122b' : '#f6f5fc';
}
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = name; a.click();
}

/* ---------- events ---------- */
$('#composer').onsubmit = e => { e.preventDefault(); send($('#input').value); };
$('#send').onclick = () => { if (busy) busy.abort(); };
$('#input').oninput = resize;
$('#input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); } };
$('#newChat').onclick = () => { cur = null; renderAll(); $('#side').classList.remove('open'); $('#input').focus(); };
$('#search').oninput = renderList;
$('#menu').onclick = () => $('#side').classList.toggle('open');
$('#theme').onclick = () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); };
$('#mode').onchange = () => { settings.mode = $('#mode').value; save(); };
$('#model').onchange = () => { settings.model = $('#model').value; save(); };
$('#filesBtn').onclick = () => { $('#drawer').hidden = false; loadFiles(); };
$('#closeFiles').onclick = () => $('#drawer').hidden = true;
$('#setBtn').onclick = async () => {
  $('#key').value = settings.key; $('#sys').value = settings.system; $('#credits').textContent = '';
  $('#settings').showModal();
  try { const { left } = await (await fetch('/api/credits', { headers: hdr() })).json(); $('#credits').textContent = left == null ? '' : `OpenRouter credits left: $${left.toFixed(2)}`; } catch {}
};
$('#settings').onclose = () => { settings.key = $('#key').value.trim(); settings.system = $('#sys').value; save(); loadModels(); };
$('#clearAll').onclick = () => { if (confirm('Delete all chats on this device?')) { chats = []; cur = null; save(); renderAll(); } };
$('#export').onclick = () => {
  if (cur?.msgs.length) download((cur.title || 'chat').replace(/[^\w-]+/g, '_') + '.md', cur.msgs.map(m => `### ${m.role === 'user' ? 'You' : 'Alpha'}\n\n${flat(m)}`).join('\n\n'));
};
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 200000) return alert('Please attach a text file under 200 KB.');
  const t = await f.text();
  $('#input').value += `${$('#input').value ? '\n\n' : ''}File: ${f.name}\n\`\`\`\n${t}\n\`\`\`\n`; resize(); e.target.value = '';
};
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $('#mic').hidden = true;
else $('#mic').onclick = () => {
  const r = new SR(); r.interimResults = false;
  r.onresult = e => { $('#input').value += (($('#input').value ? ' ' : '') + e.results[0][0].transcript); resize(); };
  r.start();
};
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.copy !== undefined) { await navigator.clipboard?.writeText(t.closest('.code').querySelector('code').textContent); t.textContent = 'Copied'; setTimeout(() => t.textContent = 'Copy', 1200); }
  else if (t.dataset.sugg) send(t.dataset.sugg);
  else if (t.dataset.approve) {
    const allow = t.dataset.allow === '1', b = cur?.msgs.at(-1)?.blocks.find(x => x.id === t.dataset.approve);
    if (b) { b.state = allow ? 'run' : 'denied'; renderLive(); }
    fetch('/api/approve', { method: 'POST', headers: hdr(), body: JSON.stringify({ id: t.dataset.approve, allow }) });
  }
  else if (t.dataset.del) { chats = chats.filter(c => c.id !== t.dataset.del); if (cur?.id === t.dataset.del) cur = null; save(); renderAll(); }
  else if (t.dataset.rm) { await fetch('/api/files/' + t.dataset.rm.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE', headers: hdr() }); loadFiles(); }
  else if (t.closest('.item') && !busy) { cur = chats.find(c => c.id === t.closest('.item').dataset.id); renderAll(); $('#side').classList.remove('open'); }
});
addEventListener('online', () => { net(); flushOutbox(); });
addEventListener('offline', net);

/* ---------- start ---------- */
$('#mode').value = settings.mode; $('#model').value = settings.model;
applyTheme(); net(); renderAll(); loadModels();
if (navigator.onLine && outbox.length) flushOutbox();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
