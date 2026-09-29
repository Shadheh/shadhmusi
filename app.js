/* Shadh Music — YouTube Music SPA
 * Requires a YouTube Data API v3 key for search/discovery.
 * Playback uses the official YouTube IFrame Player API.
 */

const CONFIG = {
  // Paste your browser-restricted YouTube Data API v3 key here, or use API setup in the UI.
  API_KEY: localStorage.getItem('shadh_youtube_api_key') || '',
  REGION: 'IN',
  LANGUAGE: 'en',
  RESULTS: 24,
};

const DEFAULT_PLAYLISTS = ['Late Night', 'Focus', 'Favourites'];
const state = {
  view: 'home',
  query: '',
  results: [],
  queue: JSON.parse(localStorage.getItem('shadh_queue') || '[]'),
  history: JSON.parse(localStorage.getItem('shadh_history') || '[]'),
  liked: JSON.parse(localStorage.getItem('shadh_liked') || '[]'),
  playlists: JSON.parse(localStorage.getItem('shadh_playlists') || JSON.stringify(Object.fromEntries(DEFAULT_PLAYLISTS.map(x => [x, []])))),
  current: JSON.parse(localStorage.getItem('shadh_current') || 'null'),
  shuffle: JSON.parse(localStorage.getItem('shadh_shuffle') || 'false'),
  repeat: localStorage.getItem('shadh_repeat') || 'off',
  dark: localStorage.getItem('shadh_theme') !== 'light',
  sleep: null,
  searchFilter: 'relevance',
};

let ytPlayer = null;
let ytReady = false;
let progressTimer = null;
let sleepTimeout = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function esc(value='') {
  return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}
function saveState() {
  localStorage.setItem('shadh_queue', JSON.stringify(state.queue));
  localStorage.setItem('shadh_history', JSON.stringify(state.history.slice(0,100)));
  localStorage.setItem('shadh_liked', JSON.stringify(state.liked));
  localStorage.setItem('shadh_playlists', JSON.stringify(state.playlists));
  localStorage.setItem('shadh_current', JSON.stringify(state.current));
  localStorage.setItem('shadh_shuffle', JSON.stringify(state.shuffle));
  localStorage.setItem('shadh_repeat', state.repeat);
  localStorage.setItem('shadh_theme', state.dark ? 'dark' : 'light');
}
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
function trackFromSearch(item) {
  const s = item.snippet || {};
  const id = item.id?.videoId || item.id;
  return { id, title: s.title || 'Untitled', channel: s.channelTitle || 'YouTube', thumb: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, published: s.publishedAt || '' };
}
function dedupe(list) { return [...new Map(list.map(x => [x.id, x])).values()]; }
function isLiked(id) { return state.liked.some(x => x.id === id); }

function render() {
  document.documentElement.classList.toggle('light-mode', !state.dark);
  $$('.nav-item[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view));
  renderSidebar(); renderQueue(); renderContent(); renderPlayer();
}

function renderSidebar() {
  $('#sidebarPlaylists').innerHTML = Object.keys(state.playlists).map(name => `<button class="playlist-chip" data-playlist="${esc(name)}">♡ ${esc(name)}</button>`).join('');
  $$('.playlist-chip').forEach(b => b.onclick = () => openPlaylist(b.dataset.playlist));
}

function renderQueue() {
  const q = state.queue;
  $('#queueList').innerHTML = q.length ? q.map((t,i) => `
    <div class="queue-item ${state.current?.id === t.id ? 'current':''}" data-index="${i}">
      <img class="queue-thumb" src="${esc(t.thumb)}" alt="" loading="lazy" />
      <div><div class="queue-title">${esc(t.title)}</div><div class="queue-sub">${esc(t.channel)}</div></div>
      <button class="queue-more" data-remove="${i}" title="Remove">×</button>
    </div>`).join('') : `<div class="empty" style="min-height:220px;border:0;background:transparent"><div><div class="empty-icon">☷</div><h3>Your queue is clear</h3><p>Add tracks with + or choose a search result to start playing.</p></div></div>`;
  $$('.queue-item').forEach(el => el.onclick = e => { if (e.target.closest('[data-remove]')) return; const t=q[+el.dataset.index]; playTrack(t); });
  $$('[data-remove]').forEach(b => b.onclick = e => { e.stopPropagation(); state.queue.splice(+b.dataset.remove,1); saveState(); renderQueue(); });
}

function cardHTML(t) {
  return `<article class="track-card" data-id="${esc(t.id)}">
    <div class="art"><img src="${esc(t.thumb)}" alt="${esc(t.title)}" loading="lazy" /><button class="card-play" data-play="${esc(t.id)}">▶</button></div>
    <div class="track-info"><div class="track-title" title="${esc(t.title)}">${esc(t.title)}</div><div class="track-channel" title="${esc(t.channel)}">${esc(t.channel)}</div></div>
    <div class="card-actions">
      <button title="Add to queue" data-add="${esc(t.id)}">＋</button>
      <button title="Like" data-like="${esc(t.id)}">${isLiked(t.id) ? '♥' : '♡'}</button>
      <button title="Add to playlist" data-pl="${esc(t.id)}">▤</button>
      <button title="Open on YouTube" data-open="${esc(t.id)}">↗</button>
    </div>
  </article>`;
}

function wireCards() {
  $$('[data-play]').forEach(b => b.onclick = () => { const t = findTrack(b.dataset.play); if(t) playTrack(t); });
  $$('[data-add]').forEach(b => b.onclick = () => { const t=findTrack(b.dataset.add); if(!t)return; addToQueue(t); });
  $$('[data-like]').forEach(b => b.onclick = () => { const t=findTrack(b.dataset.like); if(!t)return; toggleLike(t); });
  $$('[data-pl]').forEach(b => b.onclick = () => { const t=findTrack(b.dataset.pl); if(t) openPlaylistPicker(t); });
  $$('[data-open]').forEach(b => b.onclick = () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(b.dataset.open)}`, '_blank', 'noopener'));
}
function findTrack(id) { return state.results.find(x=>x.id===id) || state.queue.find(x=>x.id===id) || state.liked.find(x=>x.id===id) || state.history.find(x=>x.id===id) || Object.values(state.playlists).flat().find(x=>x.id===id); }

function renderContent() {
  const c = $('#content');
  if (state.view === 'home') return renderHome(c);
  if (state.view === 'discover') return renderDiscover(c);
  if (state.view === 'library') return renderLibrary(c);
  if (state.view === 'history') return renderCollection(c, 'Listening history', state.history, 'Your recent plays appear here.');
  if (state.view === 'liked') return renderCollection(c, 'Liked tracks', state.liked, 'Save tracks here for an instant personal library.');
  renderHome(c);
}

function renderHome(c) {
  const featured = state.results.slice(0,8);
  c.innerHTML = `
    <section class="hero glass-panel">
      <div class="hero-copy">
        <div class="eyebrow">SHADH MUSIC • YOUTUBE</div>
        <h1>A calmer way to listen.</h1>
        <p>Search YouTube, build a queue, keep your favourite tracks, and turn the whole thing into a soft, tactile player that feels closer to a music app than a web page.</p>
        <div class="hero-actions"><button class="primary-btn" id="heroSearch">Start exploring</button><button class="secondary-btn" id="heroDemo">Play a sample</button></div>
      </div>
    </section>
    <div class="section-head"><div><div class="eyebrow">DISCOVER</div><h2>${state.results.length ? 'Fresh from your search' : 'Start with a search'}</h2></div><span>${CONFIG.API_KEY ? 'YouTube connected' : 'API key not set'}</span></div>
    ${featured.length ? `<div class="card-grid">${featured.map(cardHTML).join('')}</div>` : emptySearchHTML()}
    ${state.history.length ? `<div class="section-head"><div><div class="eyebrow">RECENTLY PLAYED</div><h2>Pick up where you left off</h2></div><span>${state.history.length} tracks</span></div><div class="card-grid">${state.history.slice(0,4).map(cardHTML).join('')}</div>` : ''}
  `;
  $('#heroSearch').onclick = () => $('#searchInput').focus();
  $('#heroDemo').onclick = () => { const samples = demoTracks(); playTrack(samples[0]); };
  wireCards();
}

function renderDiscover(c) {
  c.innerHTML = `<div class="eyebrow">DISCOVER</div><h1 style="margin:5px 0 18px;font-size:32px;letter-spacing:-.05em">Find your next track.</h1>
    <div class="discovery-toolbar">${[['relevance','Relevant'],['date','Newest'],['viewCount','Most viewed'],['rating','Top rated']].map(([v,l])=>`<button class="filter-chip ${state.searchFilter===v?'active':''}" data-filter="${v}">${l}</button>`).join('')}</div>
    <div class="results-count">${state.results.length ? `${state.results.length} results${state.query ? ` for “${esc(state.query)}”` : ''}` : 'Search YouTube from the bar above.'}</div>
    <div style="height:14px"></div>${state.results.length ? `<div class="card-grid">${state.results.map(cardHTML).join('')}</div>` : emptySearchHTML()}`;
  $$('[data-filter]').forEach(b=>b.onclick=()=>{state.searchFilter=b.dataset.filter; doSearch(state.query || 'music');}); wireCards();
}

function renderLibrary(c) {
  const allPlaylists = Object.entries(state.playlists);
  c.innerHTML = `<div class="eyebrow">LIBRARY</div><h1 style="margin:5px 0 18px;font-size:32px;letter-spacing:-.05em">Your collection.</h1>
    <div class="section-head"><div><div class="eyebrow">PLAYLISTS</div><h2>Built by you</h2></div><span>${allPlaylists.length} playlists</span></div>
    ${allPlaylists.length ? `<div class="card-grid">${allPlaylists.map(([name,tracks])=>`<article class="track-card" style="padding:15px;cursor:pointer" data-open-playlist="${esc(name)}"><div class="empty-icon">♫</div><div class="track-title">${esc(name)}</div><div class="track-channel">${tracks.length} tracks • local</div></article>`).join('')}</div>` : emptyHTML('No playlists yet','Create a playlist from the sidebar.')}
    <div class="section-head"><div><div class="eyebrow">SAVED</div><h2>Liked</h2></div><span>${state.liked.length} tracks</span></div>
    ${state.liked.length ? `<div class="card-grid">${state.liked.slice(0,8).map(cardHTML).join('')}</div>` : emptyHTML('Nothing liked yet','Tap ♡ on a track to save it here.')}`;
  $$('[data-open-playlist]').forEach(b=>b.onclick=()=>openPlaylist(b.dataset.openPlaylist)); wireCards();
}

function renderCollection(c,title,items,desc) {
  c.innerHTML = `<div class="eyebrow">LIBRARY</div><h1 style="margin:5px 0 7px;font-size:32px;letter-spacing:-.05em">${esc(title)}</h1><p style="color:var(--muted);font-size:12px;margin:0 0 18px">${esc(desc)}</p>${items.length ? `<div class="card-grid">${items.map(cardHTML).join('')}</div>` : emptyHTML(title,'Nothing here yet.')}`; wireCards();
}
function emptySearchHTML() { return emptyHTML('Search the world of YouTube','Use the search bar to find songs, artists, mixes, soundtracks, live sessions and more.'); }
function emptyHTML(h,p) { return `<div class="empty"><div><div class="empty-icon">♪</div><h3>${esc(h)}</h3><p>${esc(p)}</p></div></div>`; }

function renderPlayer() {
  const t=state.current;
  $('#playerTitle').textContent = t?.title || 'Nothing playing';
  $('#playerChannel').textContent = t?.channel || 'Choose a track to start';
  $('#playerLikeBtn').textContent = t && isLiked(t.id) ? '♥' : '♡';
  $('#miniArtWrap').innerHTML = t ? `<img class="mini-art" src="${esc(t.thumb)}" alt="" />` : `<div class="mini-art placeholder-art">♪</div>`;
  $('#shuffleBtn').style.opacity = state.shuffle ? '1':'0.55';
  $('#repeatBtn').style.opacity = state.repeat !== 'off' ? '1':'0.55';
  $('#repeatBtn').textContent = state.repeat === 'one' ? '↻1' : '↻';
  const curIndex=state.queue.findIndex(x=>x.id===t?.id);
  if (curIndex >=0) { /* queue render highlights current */ }
}

function addToQueue(t) {
  if (!t) return;
  if (!state.queue.some(x=>x.id===t.id)) state.queue.push(t); else toast('Already in queue');
  saveState(); renderQueue(); toast(`${t.title.slice(0,38)} added to queue`);
}
function toggleLike(t) {
  if (isLiked(t.id)) state.liked=state.liked.filter(x=>x.id!==t.id); else state.liked.unshift(t);
  saveState(); render(); toast(isLiked(t.id)?'Added to liked':'Removed from liked');
}
function playTrack(t) {
  if (!t) return;
  state.current=t;
  if (!state.queue.some(x=>x.id===t.id)) state.queue.push(t);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,100);
  saveState(); renderPlayer(); renderQueue();
  if (ytReady && ytPlayer) {
    ytPlayer.loadVideoById(t.id);
  } else { toast('YouTube player is loading…'); }
  startProgress();
}
function nextTrack() {
  if (!state.queue.length) return;
  let idx=state.queue.findIndex(x=>x.id===state.current?.id);
  if (state.shuffle) idx=Math.floor(Math.random()*state.queue.length);
  else idx=(idx+1)%state.queue.length;
  playTrack(state.queue[idx]);
}
function prevTrack() {
  if (!state.queue.length) return;
  const idx=state.queue.findIndex(x=>x.id===state.current?.id);
  playTrack(state.queue[(idx-1+state.queue.length)%state.queue.length]);
}
function togglePlay() { if(!ytReady||!ytPlayer||!state.current){ $('#searchInput').focus(); toast('Choose a track first'); return; } const s=ytPlayer.getPlayerState(); if(s===1) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); }
function startProgress(){ clearInterval(progressTimer); progressTimer=setInterval(()=>{ if(!ytPlayer||!ytReady)return; const d=ytPlayer.getDuration(),c=ytPlayer.getCurrentTime(); $('#currentTime').textContent=fmtTime(c);$('#duration').textContent=fmtTime(d);const p=d?c/d*100:0; $('#progressRange').value=Math.round(p*10); $('#progressRange').style.setProperty('--p',`${p}%`); },400); }

async function api(path,params={}) {
  const key=CONFIG.API_KEY || localStorage.getItem('shadh_youtube_api_key') || '';
  if(!key) throw new Error('API_KEY_MISSING');
  const u=new URL(`https://www.googleapis.com/youtube/v3/${path}`); u.searchParams.set('key',key); Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));
  const r=await fetch(u); const data=await r.json(); if(!r.ok || data.error) throw new Error(data.error?.message || 'YouTube API error'); return data;
}
async function doSearch(q) {
  q=(q||'').trim(); if(!q)return;
  state.query=q; state.view='discover'; render();
  try {
    const data=await api('search', {part:'snippet', q, type:'video', videoEmbeddable:'true', videoSyndicated:'true', maxResults:CONFIG.RESULTS, order:state.searchFilter, regionCode:CONFIG.REGION, relevanceLanguage:CONFIG.LANGUAGE, safeSearch:'moderate'});
    state.results=dedupe((data.items||[]).map(trackFromSearch).filter(x=>x.id)); render(); toast(`Found ${state.results.length} tracks`);
  } catch(e) {
    console.error(e);
    state.results=demoTracks(q);
    render();
    toast(e.message==='API_KEY_MISSING'?'Add your YouTube API key in API setup':'YouTube search failed — showing demo data');
  }
}

function demoTracks(q='') {
  const titles = q ? [`${q} — official audio`, `${q} — live`, `${q} — remix`, `${q} — playlist mix`] : ['Midnight City — sample search','Ocean Drive — sample search','Night Changes — sample search','Sunset Lover — sample search'];
  const ids=['kJQP7kiw5Fk','5qap5aO4i9A','OPf0YbXqDm0','RBumgq5yVrA'];
  return titles.map((title,i)=>({id:ids[i],title,channel:'Demo data · connect YouTube API',thumb:`https://i.ytimg.com/vi/${ids[i]}/hqdefault.jpg`}));
}

function onPlayerStateChange(e) {
  const s=e.data;
  $('#playPauseBtn').textContent = s===1 ? 'Ⅱ' : '▶';
  if(s===0) {
    if(state.repeat==='one' && state.current) { ytPlayer.playVideo(); return; }
    nextTrack();
  }
}

function onYouTubeIframeAPIReady() {
  ytPlayer=new YT.Player('youtubePlayer',{height:'1',width:'1',videoId:state.current?.id||'',playerVars:{autoplay:0,controls:0,disablekb:1,modestbranding:1,playsinline:1,rel:0},events:{onReady:(e)=>{ytReady=true;e.target.setVolume(+$('#volumeRange').value);startProgress();},onStateChange:onPlayerStateChange,onError:(e)=>toast(`YouTube playback error (${e.data})`)}});
}
window.onYouTubeIframeAPIReady=onYouTubeIframeAPIReady;

function openModal(html) { $('#modalContent').innerHTML=html; $('#modalBackdrop').hidden=false; }
function closeModal() { $('#modalBackdrop').hidden=true; }
function openApiSetup(){
  openModal(`<h3>Connect YouTube</h3><p>Shadh Music uses the YouTube Data API v3 for search/discovery and the official YouTube IFrame Player API for playback. A browser-restricted API key is enough for search; OAuth is not needed for these public reads.</p>
    <div class="field"><label>YouTube Data API v3 key</label><input id="apiKeyInput" type="password" value="${esc(CONFIG.API_KEY)}" placeholder="AIza…" autocomplete="off" /></div>
    <div class="settings-grid"><div class="setting-card"><strong>Step 1</strong><span>Create a Google Cloud project and enable YouTube Data API v3.</span></div><div class="setting-card"><strong>Step 2</strong><span>Create an API key and restrict it to your website origin + YouTube Data API.</span></div></div>
    <div class="modal-row"><button class="secondary-btn" id="apiClearBtn">Clear key</button><button class="primary-btn" id="apiSaveBtn">Save & connect</button></div>`);
  $('#apiSaveBtn').onclick=()=>{ const k=$('#apiKeyInput').value.trim(); CONFIG.API_KEY=k; localStorage.setItem('shadh_youtube_api_key',k); closeModal(); toast(k?'YouTube API key saved':'API key cleared'); };
  $('#apiClearBtn').onclick=()=>{CONFIG.API_KEY='';localStorage.removeItem('shadh_youtube_api_key');$('#apiKeyInput').value='';toast('API key cleared');};
}
function openSettings(){
  openModal(`<h3>Settings</h3><p>Everything here stays local in your browser unless a YouTube request is made.</p>
  <div class="settings-grid"><div class="setting-card"><strong>Theme</strong><span>${state.dark?'OLED dark':'Light clay'} appearance.</span></div><div class="setting-card"><strong>Storage</strong><span>Queue, likes, playlists and history use localStorage.</span></div><div class="setting-card"><strong>Region</strong><span>Search region is currently ${CONFIG.REGION}.</span></div><div class="setting-card"><strong>Keyboard</strong><span>Space play/pause • J previous • L next • S shuffle • R repeat • / search.</span></div></div>
  <div class="modal-row"><button class="secondary-btn" id="resetBtn">Reset local data</button><button class="primary-btn" id="closeSetBtn">Done</button></div>`);
  $('#closeSetBtn').onclick=closeModal; $('#resetBtn').onclick=()=>{localStorage.clear();location.reload();};
}
function openPlaylist(name){
  const tracks=state.playlists[name]||[]; state.results=tracks; state.view='discover'; state.query=''; render(); toast(`${name} • ${tracks.length} tracks`);
}
function openPlaylistPicker(t){
  const names=Object.keys(state.playlists);
  openModal(`<h3>Add to playlist</h3><p>${esc(t.title)}</p><div class="settings-grid">${names.map(n=>`<button class="setting-card" data-pick="${esc(n)}"><strong>${esc(n)}</strong><span>${state.playlists[n].length} tracks</span></button>`).join('')}</div><div class="modal-row"><button class="secondary-btn" id="newFromPicker">＋ New playlist</button></div>`);
  $$('[data-pick]').forEach(b=>b.onclick=()=>{const n=b.dataset.pick; if(!state.playlists[n].some(x=>x.id===t.id)) state.playlists[n].push(t); saveState(); closeModal(); renderSidebar(); toast(`Added to ${n}`);});
  $('#newFromPicker').onclick=()=>{closeModal();createPlaylist(t);};
}
function createPlaylist(seed=null){
  openModal(`<h3>New playlist</h3><p>Create a small local collection. You can fill it from any track's playlist button.</p><div class="field"><label>Playlist name</label><input id="plName" maxlength="40" placeholder="e.g. Sunday Drive" /></div><div class="modal-row"><button class="secondary-btn" id="cancelPl">Cancel</button><button class="primary-btn" id="savePl">Create</button></div>`);
  $('#cancelPl').onclick=closeModal; $('#savePl').onclick=()=>{const n=$('#plName').value.trim();if(!n)return toast('Enter a name');if(!state.playlists[n])state.playlists[n]=seed?[seed]:[];saveState();closeModal();render();toast(`Playlist “${n}” created`);};
}
function openSleepTimer(){
  openModal(`<h3>Sleep timer</h3><p>Stop playback automatically after the selected duration.</p><div class="settings-grid">${[15,30,45,60,90].map(m=>`<button class="setting-card" data-sleep="${m}"><strong>${m} minutes</strong><span>Stop YouTube playback</span></button>`).join('')}<button class="setting-card" data-sleep="0"><strong>Off</strong><span>Cancel timer</span></button></div>`);
  $$('[data-sleep]').forEach(b=>b.onclick=()=>{const m=+b.dataset.sleep; clearTimeout(sleepTimeout); state.sleep=m?Date.now()+m*60000:null; sleepTimeout=m?setTimeout(()=>{if(ytPlayer)ytPlayer.pauseVideo();state.sleep=null;toast('Sleep timer finished');},m*60000):null;closeModal();toast(m?`Sleep timer: ${m} min`:'Sleep timer off');});
}

// Navigation / UI events
$$('.nav-item[data-view]').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render();});
$('#newPlaylistBtn').onclick=()=>createPlaylist();
$('#settingsBtn').onclick=openSettings;
$('#apiBtn').onclick=openApiSetup;
$('#mobileMenuBtn').onclick=()=>$('.sidebar').classList.toggle('open');
$('#modalClose').onclick=closeModal;
$('#modalBackdrop').onclick=e=>{if(e.target.id==='modalBackdrop')closeModal();};
$('#themeBtn').onclick=()=>{state.dark=!state.dark;saveState();render();};
$('#sleepBtn').onclick=openSleepTimer;
$('#profileBtn').onclick=()=>toast('Local profile · Shadh');
$('#focusSearchBtn').onclick=()=>$('#searchInput').focus();
$('#searchInput').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch(e.target.value);});
$('#playPauseBtn').onclick=togglePlay;
$('#nextBtn').onclick=nextTrack;
$('#prevBtn').onclick=prevTrack;
$('#shuffleBtn').onclick=()=>{state.shuffle=!state.shuffle;saveState();renderPlayer();toast(state.shuffle?'Shuffle on':'Shuffle off');};
$('#shuffleQueueBtn').onclick=()=>{state.queue.sort(()=>Math.random()-.5);state.shuffle=true;saveState();renderQueue();renderPlayer();toast('Queue shuffled');};
$('#repeatBtn').onclick=()=>{state.repeat=state.repeat==='off'?'all':state.repeat==='all'?'one':'off';saveState();renderPlayer();toast(`Repeat ${state.repeat}`);};
$('#clearQueueBtn').onclick=()=>{state.queue=[];state.current=null;saveState();renderQueue();renderPlayer();toast('Queue cleared');};
$('#queueToggleBtn').onclick=()=>$('#queuePanel').scrollIntoView({behavior:'smooth'});
$('#miniPlayerBtn').onclick=()=>toast('Mini player is optimized for mobile');
$('#playerLikeBtn').onclick=()=>{if(state.current)toggleLike(state.current);};
$('#volumeRange').oninput=e=>{if(ytPlayer)ytPlayer.setVolume(+e.target.value);e.target.style.setProperty('--p',`${e.target.value}%`);};
$('#progressRange').oninput=e=>{if(ytPlayer&&ytPlayer.getDuration()){ytPlayer.seekTo((+e.target.value/1000)*ytPlayer.getDuration(),true);} };

document.addEventListener('keydown',e=>{
  if(['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if(e.key===' '){e.preventDefault();togglePlay();}
  if(e.key.toLowerCase()==='j')prevTrack();
  if(e.key.toLowerCase()==='l')nextTrack();
  if(e.key.toLowerCase()==='s'){$('#shuffleBtn').click();}
  if(e.key.toLowerCase()==='r'){$('#repeatBtn').click();}
  if(e.key==='/'){e.preventDefault();$('#searchInput').focus();}
});

// Initial render
render();
if(!CONFIG.API_KEY) setTimeout(()=>toast('Tip: connect a YouTube API key for live search'),900);
