// ollama-web-frontend — app.js (STREAMING with buffered fallback)

const el = (id) => document.getElementById(id);
const messagesEl = el('messages');
const modelEl    = el('model');
const systemEl   = el('system');
const inputEl    = el('input');
const formEl     = el('composer');
const statusEl   = el('status');
const tempEl     = el('temperature');
const clearBtn   = el('clear');

const STORAGE_KEY = 'ollama-ui-state-v1';
let state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
let inflight = null; // AbortController for the current stream

function setStatus(t){ statusEl.textContent = t; }
function getKey(){ return modelEl.value || '__default__'; }

function saveState(){
  const payload = {
    model: modelEl.value,
    system: systemEl.value,
    history: state.history || {},
    temperature: tempEl.value
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function getThread(){
  const k = getKey();
  state.history = state.history || {};
  state.history[k] = state.history[k] || [];
  return state.history[k];
}

function addMsg(role, content){
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const r = document.createElement('div'); r.className = 'role'; r.textContent = role;
  const c = document.createElement('div'); c.textContent = content;
  div.appendChild(r); div.appendChild(c);
  messagesEl.appendChild(div);
}

function renderHistory(){
  messagesEl.innerHTML = '';
  for (const m of getThread()) addMsg(m.role, m.content);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadModels(){
  try{
    setStatus('Loading models…');
    const res = await fetch('/models');
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    modelEl.innerHTML = '';
    (data.models || []).forEach(name=>{
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      modelEl.appendChild(opt);
    });
    const preferred =
      (state.model && (data.models||[]).includes(state.model))
        ? state.model
        : ((data.models||[]).find(m=>/qwen|llama|mistral|phi|gemma/i.test(m)) || (data.models||[])[0]);
    if (preferred) modelEl.value = preferred;
    saveState(); setStatus('Ready');
  }catch(e){
    console.error('loadModels failed:', e);
    setStatus('Failed to load models');
  }
}

async function sendMessage(userText){
  const model = modelEl.value;
  const temperature = Number(tempEl.value || 0.2);

  // Build outbound messages (prepend system if provided)
  const outbound = [];
  const sys = (systemEl.value || '').trim();
  if (sys) outbound.push({ role:'system', content: sys });
  for (const m of getThread()) outbound.push({ role:m.role, content:m.content });
  outbound.push({ role:'user', content:userText });

  // Append user to history right away
  const thread = getThread();
  thread.push({ role:'user', content:userText });
  saveState(); renderHistory();

  setStatus(`Thinking with ${model}…`);

  // Create assistant bubble (live-updated while streaming)
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
      body: JSON.stringify({ model, messages: outbound, options:{ temperature } }),
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

    // Save final streamed text
    thread.push({ role:'assistant', content: assistantText || '(no content)' });
    saveState(); renderHistory(); setStatus('Ready');
    return;
  } catch (e) {
    console.warn('Streaming failed, falling back to buffered:', e.message);
  }

  // Buffered fallback (uses /chat)
  try{
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ model, messages: outbound, options:{ temperature } })
    });

    if(!res.ok){
      const body = await res.text().catch(()=> '');
      const msg = `Error: ${res.status} ${res.statusText} ${body}`;
      thread.push({ role:'assistant', content: msg });
      saveState(); renderHistory(); setStatus('Error');
      return;
    }

    const textResp = await res.text();
    thread.push({ role:'assistant', content: textResp || '(no content)' });
    saveState(); renderHistory(); setStatus('Ready');
  }catch(e){
    const msg = `Network error: ${e.message}`;
    thread.push({ role:'assistant', content: msg });
    saveState(); renderHistory(); setStatus('Error');
  }
}

// Events
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
  state.history = state.history || {};
  state.history[getKey()] = [];
  saveState(); renderHistory();
});

modelEl.addEventListener('change', ()=>{ saveState(); renderHistory(); });
[systemEl, tempEl].forEach(x=> x.addEventListener('change', saveState));

// Init
(async function init(){
  await loadModels();
  state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  renderHistory();
  if (state.system) systemEl.value = state.system;
  if (state.temperature) tempEl.value = state.temperature;
})();

