// ollama-web-frontend — app.js (STREAMING + Multi-Chat, hardened models)

// ------- DOM -------
const qs  = (s) => document.querySelector(s);
const messagesEl = qs('#messages');
const modelEl    = qs('#model');
const systemEl   = qs('#system');
const inputEl    = qs('#input');
const formEl     = qs('#composer');
const statusEl   = qs('#status');
const tempEl     = qs('#temperature');
const clearBtn   = qs('#clear');
const stopBtn    = qs('#stop');           // may not exist
const newChatBtn = qs('#newChat');        // may not exist
const chatListEl = qs('#chatList');       // may not exist
const setStatus  = (t) => { if (statusEl) statusEl.textContent = t; };

// ------- Utils -------
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function genId(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ------- State (multi-chat) -------
/*
state = {
  chats: [{ id, title, model, system, temperature, messages:[{role,content}], createdAt }],
  activeChatId: string
}
*/
const STORAGE_KEY = 'ollama-ui-state-v2';

function loadState(){
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (s && Array.isArray(s.chats)) return s;
  } catch {}
  // default with one empty chat
  const id = genId();
  return { chats: [{ id, title: 'Chat', model: '', system: '', temperature: 0.2, messages: [], createdAt: Date.now() }], activeChatId: id };
}

function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

let state = loadState();
let inflight = null; // AbortController for the current stream

// Migration from old per-model storage if present:
(function migrateV1() {
  try {
    const legacy = JSON.parse(localStorage.getItem('ollama-ui-state-v1') || 'null');
    if (!legacy) return;
    if (state.chats.length === 0) {
      const id = genId();
      state.chats.push({
        id,
        title: legacy.model ? `Chat (${legacy.model})` : 'Chat',
        model: legacy.model || '',
        system: legacy.system || '',
        temperature: legacy.temperature ? Number(legacy.temperature) : 0.2,
        messages: Array.isArray(legacy.history?.[legacy.model || '__default__']) ? legacy.history[legacy.model || '__default__'] : [],
        createdAt: Date.now()
      });
      state.activeChatId = id;
      saveState();
    }
    localStorage.removeItem('ollama-ui-state-v1'); // cleanup
  } catch {}
})();

function currentChat(){
  const id = state.activeChatId;
  const c = state.chats.find(x => x.id === id);
  return c || state.chats[0];
}

// ------- Chat list UI -------
function renderChatList(){
  if (!chatListEl) return;
  chatListEl.innerHTML = '';
  for (const chat of state.chats.slice().sort((a,b)=> b.createdAt - a.createdAt)) {
    const li = document.createElement('li');
    li.dataset.id = chat.id;
    if (chat.id === state.activeChatId) li.classList.add('active');

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = chat.title || 'Chat';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const ren = document.createElement('button'); ren.textContent = 'Rename';
    const del = document.createElement('button'); del.textContent = 'Delete';
    actions.appendChild(ren); actions.appendChild(del);

    li.appendChild(title); li.appendChild(actions);
    chatListEl.appendChild(li);

    title.addEventListener('click', ()=> switchChat(chat.id));
    ren.addEventListener('click', (e)=> { e.stopPropagation(); renameChat(chat.id); });
    del.addEventListener('click', (e)=> { e.stopPropagation(); deleteChat(chat.id); });
  }
}

function switchChat(id){
  if (state.activeChatId === id) return;
  state.activeChatId = id;
  saveState();
  renderChatList();
  renderHistory();
}

function newChat(){
  const id = genId();
  const modelGuess = modelEl?.value || '';
  state.chats.push({
    id,
    title: modelGuess ? `Chat (${modelGuess})` : 'Chat',
    model: modelGuess,
    system: '',
    temperature: Number(tempEl?.value || 0.2),
    messages: [],
    createdAt: Date.now()
  });
  state.activeChatId = id;
  saveState();
  renderChatList();
  renderHistory();
}

function renameChat(id){
  const chat = state.chats.find(x => x.id === id);
  if (!chat) return;
  const t = prompt('New title', chat.title || 'Chat');
  if (t == null) return;
  chat.title = t.trim() || 'Chat';
  saveState();
  renderChatList();
}

function deleteChat(id){
  if (!confirm('Delete this chat?')) return;
  const idx = state.chats.findIndex(x => x.id === id);
  if (idx === -1) return;
  state.chats.splice(idx, 1);
  if (state.chats.length === 0) {
    // ensure at least one
    const nid = genId();
    state.chats.push({ id: nid, title: 'Chat', model: '', system: '', temperature: 0.2, messages: [], createdAt: Date.now() });
    state.activeChatId = nid;
  } else if (state.activeChatId === id) {
    state.activeChatId = state.chats[0].id;
  }
  saveState();
  renderChatList();
  renderHistory();
}

// ------- History render -------
function addMsg(role, content){
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const r = document.createElement('div'); r.className = 'role'; r.textContent = role;
  const c = document.createElement('div'); c.textContent = content || '';
  div.appendChild(r); div.appendChild(c);
  messagesEl.appendChild(div);
}

function renderHistory(){
  messagesEl.innerHTML = '';
  const chat = currentChat();
  for (const m of chat.messages) addMsg(m.role, m.content);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Reflect chat settings into UI controls
  if (modelEl) modelEl.value = chat.model || modelEl.value || '';
  if (systemEl) systemEl.value = chat.system || '';
  if (tempEl)   tempEl.value   = (typeof chat.temperature === 'number' ? chat.temperature : 0.2);
}

// ------- Models (retry + auto-heal) -------
async function fetchModelsOnce(){
  const res = await fetch('/models', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/models -> ${res.status} ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

async function loadModelsRetry(){
  setStatus('Loading models…');
  const sel = modelEl;
  const delays = [0, 800, 2000];  // up to 3 tries
  let list = [];
  for (const d of delays){
    if (d) await sleep(d);
    try { list = await fetchModelsOnce(); break; }
    catch(e){ console.warn('loadModels attempt failed:', e); }
  }

  sel.innerHTML = '';
  for (const name of list){
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  if (!list.length) { setStatus('No models found on Ollama'); return; }

  // prefer saved/current chat model if present
  const chat = currentChat();
  const preferred = (chat.model && list.includes(chat.model))
    ? chat.model
    : (list.find(m => /qwen|llama|mistral|phi|gemma/i.test(m)) || list[0]);

  sel.value = preferred;
  chat.model = preferred;
  saveState();
  setStatus('Ready');
}

// ------- Send/Stream -------
async function sendMessage(userText){
  // ensure a model is selected before sending
  if (!modelEl || !modelEl.value) {
    try { setStatus('Loading models…'); await loadModelsRetry(); }
    catch (e) {
      const msg = `Cannot send: no model selected (${e.message || e})`;
      const chat = currentChat();
      chat.messages.push({ role:'assistant', content: msg });
      saveState(); renderHistory(); setStatus('Error');
      return;
    }
  }

  const chat = currentChat();
  chat.model = modelEl.value;
  chat.system = systemEl.value;
  chat.temperature = Number(tempEl.value || 0.2);
  saveState();

  // Build outbound messages (prepend system if provided)
  const outbound = [];
  const sys = (chat.system || '').trim();
  if (sys) outbound.push({ role:'system', content: sys });
  for (const m of chat.messages) outbound.push({ role:m.role, content:m.content });
  outbound.push({ role:'user', content:userText });

  // Append user locally
  chat.messages.push({ role:'user', content:userText });
  saveState(); renderHistory();

  setStatus(`Thinking with ${chat.model}…`);

  // Create assistant bubble (live-updated)
  const assistantDiv = document.createElement('div');
  assistantDiv.className = 'msg assistant';
  const roleSpan = document.createElement('div'); roleSpan.className = 'role'; roleSpan.textContent = 'assistant';
  const contentSpan = document.createElement('div'); contentSpan.textContent = '';
  assistantDiv.appendChild(roleSpan); assistantDiv.appendChild(contentSpan);
  messagesEl.appendChild(assistantDiv);

  // Cancel any in-flight stream
  if (inflight) inflight.abort();
  inflight = new AbortController();

  // Try streaming first
  try{
    const res = await fetch('/chat_stream', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ model: chat.model, messages: outbound, options:{ temperature: chat.temperature } }),
      signal: inflight.signal
    });

    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        assistantText += chunk;
        contentSpan.textContent = assistantText;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    chat.messages.push({ role:'assistant', content: assistantText || '(no content)' });
    saveState(); renderHistory(); setStatus('Ready');
    return;
  } catch (e) {
    console.warn('Streaming failed, falling back to buffered:', e.message);
  }

  // Buffered fallback
  try{
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ model: chat.model, messages: outbound, options:{ temperature: chat.temperature } })
    });

    if(!res.ok){
      const body = await res.text().catch(()=> '');
      const msg = `Error: ${res.status} ${res.statusText} ${body}`;
      chat.messages.push({ role:'assistant', content: msg });
      saveState(); renderHistory(); setStatus('Error');
      return;
    }

    const textResp = await res.text();
    chat.messages.push({ role:'assistant', content: textResp || '(no content)' });
    saveState(); renderHistory(); setStatus('Ready');
  }catch(e){
    const msg = `Network error: ${e.message}`;
    chat.messages.push({ role:'assistant', content: msg });
    saveState(); renderHistory(); setStatus('Error');
  }
}

// ------- Events -------
formEl.addEventListener('submit', (e)=>{
  e.preventDefault();
  const text = (inputEl.value || '').trim();
  if(!text) return;
  inputEl.value = '';
  sendMessage(text);
});

inputEl.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    const text = (inputEl.value || '').trim();
    if(!text) return;
    inputEl.value = '';
    sendMessage(text);
  }
});

clearBtn.addEventListener('click', ()=>{
  const chat = currentChat();
  chat.messages = [];
  saveState(); renderHistory();
});

if (stopBtn) {
  stopBtn.addEventListener('click', ()=>{
    if (inflight) inflight.abort();
    setStatus('Stopped');
  });
}

if (newChatBtn) newChatBtn.addEventListener('click', newChat);

modelEl.addEventListener('change', ()=>{
  const chat = currentChat();
  chat.model = modelEl.value;
  saveState();
});

[systemEl, tempEl].forEach(x => x && x.addEventListener('change', ()=>{
  const chat = currentChat();
  chat.system = systemEl.value;
  chat.temperature = Number(tempEl.value || 0.2);
  saveState();
}));

// ------- Init -------
(async function init(){
  try { await loadModelsRetry(); } catch(e){ console.error(e); }
  renderChatList();
  renderHistory();

  // If model list somehow ended empty, retry once after 2s
  setTimeout(async ()=>{
    if (!modelEl.options.length) await loadModelsRetry();
  }, 2000);

  // Auto-heal every 15s if select ever becomes empty
  setInterval(() => {
    if (!modelEl || !modelEl.options || modelEl.options.length === 0) {
      loadModelsRetry().catch(err => console.warn('auto-heal loadModels failed:', err));
    }
  }, 15000);
})();

