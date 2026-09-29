/* Shadh Music v4 — local-first YouTube music player with robust state, settings and recommendations. */

const STORAGE = 'shadh_music_v4';
const LEGACY_STORAGE = 'shadh_music_v2';
const DEFAULT_PLAYLISTS = ['Late Night', 'Focus', 'Favourites'];
const DEFAULT_SETTINGS = {
  theme: 'dark',
  autoplayNext: true,
  autoRadio: true,
  compactCards: false,
  reduceMotion: false,
  showQueue: true,
  pauseWhenHidden: false,
  rememberVolume: true,
  confirmDestructive: true,
  region: window.SHADH_CONFIG?.REGION || 'IN',
  language: window.SHADH_CONFIG?.LANGUAGE || 'en',
  recommendationMode: 'balanced'
};

const safeJSON = (key, fallback) => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

function readInitialState() {
  const legacy = safeJSON(LEGACY_STORAGE, {});
  const saved = safeJSON(STORAGE, {});
  const merged = { ...legacy, ...saved };
  return {
    view: merged.view || 'home',
    query: '',
    results: [],
    nextPageToken: '',
    totalResults: 0,
    recommendations: [],
    trending: [],
    current: merged.current || null,
    queue: Array.isArray(merged.queue) ? merged.queue : [],
    history: Array.isArray(merged.history) ? merged.history : [],
    liked: Array.isArray(merged.liked) ? merged.liked : [],
    playlists: merged.playlists && typeof merged.playlists === 'object' ? merged.playlists : Object.fromEntries(DEFAULT_PLAYLISTS.map(x => [x, []])),
    recentSearches: Array.isArray(merged.recentSearches) ? merged.recentSearches : [],
    shuffle: !!merged.shuffle,
    repeat: merged.repeat || 'off',
    theme: merged.theme || (merged.dark === false ? 'light' : 'dark'),
    volume: Number.isFinite(merged.volume) ? merged.volume : 80,
    muted: !!merged.muted,
    searchFilter: merged.searchFilter || 'relevance',
    settings: { ...DEFAULT_SETTINGS, ...(merged.settings || {}) },
    listeningSeconds: Number.isFinite(merged.listeningSeconds) ? merged.listeningSeconds : 0,
    currentStartedAt: 0,
    loading: false,
    loadingMore: false,
    recLoading: false,
    error: '',
    recommendationKey: '',
    lastRecommendationAt: 0
  };
}

const state = readInitialState();
for (const p of DEFAULT_PLAYLISTS) if (!state.playlists[p]) state.playlists[p] = [];
state.queue = dedupe(state.queue.map(normalizeTrack));
state.history = dedupe(state.history.map(normalizeTrack));
state.liked = dedupe(state.liked.map(normalizeTrack));
for (const [name, tracks] of Object.entries(state.playlists)) state.playlists[name] = dedupe((Array.isArray(tracks) ? tracks : []).map(normalizeTrack));
state.current = normalizeTrack(state.current);

const CONFIG = {
  API_KEY: localStorage.getItem('shadh_youtube_api_key') || window.SHADH_CONFIG?.YOUTUBE_API_KEY || '',
  REGION: state.settings.region,
  LANGUAGE: state.settings.language,
  RESULTS: Number(window.SHADH_CONFIG?.RESULTS || 24)
};

let ytPlayer = null;
let ytReady = false;
let ytApiFailed = false;
let progressTimer = null;
let statsTimer = null;
let sleepTimeout = null;
let draggedIndex = -1;
let voiceRecognition = null;
let mobileQueueOpen = false;
let systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)');
const searchCache = new Map();

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const htmlEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const attrEsc = htmlEsc;
const thumb = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
const fmt = sec => { if (!Number.isFinite(sec) || sec < 0) return '0:00'; const s = Math.floor(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const compact = n => { n = Number(n); if (!Number.isFinite(n) || !n) return ''; if (n >= 1e9) return `${(n/1e9).toFixed(1)}B`; if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n/1e3).toFixed(1)}K`; return String(n); };
const escapeTitle = htmlEsc;

function normalizeTrack(t) {
  if (!t || !t.id) return null;
  return {
    id: String(t.id),
    title: String(t.title || 'Untitled'),
    channel: String(t.channel || 'YouTube'),
    thumb: t.thumb || thumb(t.id),
    published: t.published || '',
    views: Number(t.views || 0) || 0
  };
}
function dedupe(arr) { return [...new Map(arr.filter(Boolean).map(t => [t.id, t])).values()]; }
function isLiked(id) { return state.liked.some(t => t.id === id); }
function findTrack(id) {
  return state.results.find(t => t.id === id)
    || state.recommendations.find(t => t.id === id)
    || state.trending.find(t => t.id === id)
    || state.queue.find(t => t.id === id)
    || state.liked.find(t => t.id === id)
    || state.history.find(t => t.id === id)
    || Object.values(state.playlists).flat().find(t => t.id === id)
    || (state.current?.id === id ? state.current : null)
    || null;
}
function formatPublish(date) {
  if (!date) return '';
  const age = Date.now() - new Date(date).getTime();
  if (!Number.isFinite(age)) return '';
  const d = Math.floor(age / 86400000);
  if (d < 1) return 'Today'; if (d < 7) return `${d}d`; if (d < 30) return `${Math.floor(d/7)}w`; if (d < 365) return `${Math.floor(d/30)}mo`; return `${Math.floor(d/365)}y`;
}
function currentThemeIsDark() {
  if (state.settings.theme === 'system') return systemThemeMedia ? systemThemeMedia.matches : true;
  return state.settings.theme !== 'light';
}
function persist() {
  const data = {
    view: state.view, queue: state.queue.slice(0, 150), history: state.history.slice(0, 150), liked: state.liked.slice(0, 500), playlists: state.playlists,
    current: state.current, shuffle: state.shuffle, repeat: state.repeat, volume: state.volume, muted: state.muted,
    recentSearches: state.recentSearches.slice(0, 20), searchFilter: state.searchFilter, theme: state.settings.theme, settings: state.settings,
    listeningSeconds: Math.floor(state.listeningSeconds)
  };
  try { localStorage.setItem(STORAGE, JSON.stringify(data)); } catch { toast('Local storage is full'); }
  if (CONFIG.API_KEY) localStorage.setItem('shadh_youtube_api_key', CONFIG.API_KEY);
}
function toast(message) {
  const el = $('#toast'); if (!el) return;
  el.textContent = message; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}
function confirmAction(message) { return !state.settings.confirmDestructive || window.confirm(message); }
function setView(view) {
  state.view = view;
  $('#sidebar')?.classList.remove('open');
  closePanel();
  render();
  window.scrollTo({ top: 0, behavior: state.settings.reduceMotion ? 'auto' : 'smooth' });
}

function trackFromSearch(item) {
  const s = item?.snippet || {};
  const id = item?.id?.videoId || item?.id;
  if (!id) return null;
  return normalizeTrack({ id, title: s.title, channel: s.channelTitle, thumb: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || thumb(id), published: s.publishedAt });
}

function cardHTML(t) {
  const liked = isLiked(t.id);
  return `<article class="track-card">
    <div class="art"><img src="${attrEsc(t.thumb || thumb(t.id))}" alt="${escapeTitle(t.title)}" loading="lazy"><button class="card-play" data-play="${attrEsc(t.id)}" aria-label="Play ${escapeTitle(t.title)}">▶</button></div>
    <div class="track-info"><div class="track-title" title="${escapeTitle(t.title)}">${escapeTitle(t.title)}</div><div class="track-channel" title="${htmlEsc(t.channel)}">${htmlEsc(t.channel)}</div></div>
    <div class="meta-row">${t.published ? `<span>${formatPublish(t.published)}</span>` : ''}${t.views ? `<span>• ${compact(t.views)} views</span>` : ''}</div>
    <div class="card-actions"><button title="Add to queue" data-add="${attrEsc(t.id)}">＋</button><button title="${liked?'Unlike':'Like'}" data-like="${attrEsc(t.id)}">${liked?'♥':'♡'}</button><button title="Add to playlist" data-pl="${attrEsc(t.id)}">▤</button><button title="Copy YouTube link" data-copy="${attrEsc(t.id)}">⛓</button><button title="Open on YouTube" data-open="${attrEsc(t.id)}">↗</button></div>
  </article>`;
}
function wireCards() {
  $$('[data-play]').forEach(b => b.onclick = () => { const t = findTrack(b.dataset.play); if (t) playTrack(t); });
  $$('[data-add]').forEach(b => b.onclick = () => { const t = findTrack(b.dataset.add); if (t) addToQueue(t); });
  $$('[data-like]').forEach(b => b.onclick = () => { const t = findTrack(b.dataset.like); if (t) toggleLike(t); });
  $$('[data-pl]').forEach(b => b.onclick = () => { const t = findTrack(b.dataset.pl); if (t) openPlaylistPicker(t); });
  $$('[data-copy]').forEach(b => b.onclick = async () => { const url = `https://www.youtube.com/watch?v=${encodeURIComponent(b.dataset.copy)}`; try { await navigator.clipboard.writeText(url); toast('YouTube link copied'); } catch { window.prompt('Copy this link', url); } });
  $$('[data-open]').forEach(b => b.onclick = () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(b.dataset.open)}`, '_blank', 'noopener,noreferrer'));
}

function render() {
  const dark = currentThemeIsDark();
  document.documentElement.classList.toggle('light-mode', !dark);
  document.documentElement.classList.toggle('reduced-motion', !!state.settings.reduceMotion);
  document.documentElement.classList.toggle('compact-cards', !!state.settings.compactCards);
  document.documentElement.classList.toggle('hide-desktop-queue', !state.settings.showQueue);
  $$('.nav-item[data-view], .mobile-nav [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#likedCount').textContent = state.liked.length;
  $('#apiStatusDot').classList.toggle('connected', !!CONFIG.API_KEY);
  $('#apiStatusDot').title = CONFIG.API_KEY ? (ytReady ? 'YouTube connected' : 'YouTube key saved') : 'YouTube not connected';
  renderSidebar(); renderQueue(); renderContent(); renderPlayer(); renderVolume();
  document.title = state.current ? `${state.current.title} — Shadh Music` : 'Shadh Music';
}
function renderSidebar() {
  const el = $('#sidebarPlaylists');
  el.innerHTML = Object.entries(state.playlists).map(([name, tracks]) => `<button class="playlist-chip" data-playlist="${attrEsc(name)}">♫ ${htmlEsc(name)} <span>${tracks.length}</span></button>`).join('');
  $$('[data-playlist]').forEach(b => b.onclick = () => openPlaylist(b.dataset.playlist));
}
function queueHTML(t, i) {
  return `<div class="queue-item ${state.current?.id === t.id ? 'current' : ''}" draggable="true" data-index="${i}"><img class="queue-thumb" src="${attrEsc(t.thumb)}" alt="" loading="lazy"><div><div class="queue-title">${escapeTitle(t.title)}</div><div class="queue-sub">${htmlEsc(t.channel)}</div></div><button class="queue-more" data-remove-queue="${i}" title="Remove">×</button></div>`;
}
function renderQueue() {
  const q = state.queue;
  const panel = $('#queuePanel');
  panel.classList.toggle('mobile-open', mobileQueueOpen);
  $('#queueCount').textContent = q.length;
  $('#queueList').innerHTML = q.length ? q.map(queueHTML).join('') : `<div class="empty queue-empty"><div><div class="empty-icon">☷</div><h3>Your queue is clear</h3><p>Add tracks from search or recommendations. Drag to reorder on desktop.</p></div></div>`;
  $$('[data-remove-queue]').forEach(b => b.onclick = e => { e.stopPropagation(); const i = +b.dataset.removeQueue; state.queue.splice(i, 1); persist(); renderQueue(); toast('Removed from queue'); });
  $$('.queue-item[draggable]').forEach(el => {
    el.addEventListener('click', e => { if (!e.target.closest('[data-remove-queue]')) playTrack(state.queue[+el.dataset.index]); });
    el.addEventListener('dragstart', () => { draggedIndex = +el.dataset.index; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { draggedIndex = -1; el.classList.remove('dragging'); });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', e => { e.preventDefault(); const to = +el.dataset.index; if (draggedIndex < 0 || draggedIndex === to) return; const [m] = state.queue.splice(draggedIndex, 1); state.queue.splice(to, 0, m); persist(); renderQueue(); });
  });
}

function renderContent() {
  const c = $('#content');
  if (state.view === 'home') renderHome(c);
  else if (state.view === 'discover') renderDiscover(c);
  else if (state.view === 'library') renderLibrary(c);
  else if (state.view === 'liked') renderCollection(c, 'Liked tracks', state.liked, 'Tracks you saved on this device.');
  else if (state.view === 'history') renderCollection(c, 'Listening history', state.history, 'Your recent listening history, stored locally.');
  else if (state.view === 'settings') renderSettings(c);
  else renderHome(c);
}

function renderHome(c) {
  const basis = state.current?.title || state.history[0]?.title || '';
  c.innerHTML = `<section class="hero glass"><div class="hero-copy"><div class="eyebrow">SHADH MUSIC • PERSONAL PLAYER</div><h1>Your music, your atmosphere.</h1><p>Search YouTube, build a queue, save playlists and let your listening history shape the next tracks you discover.</p><div class="hero-actions"><button class="primary-btn" id="heroSearch">Search music</button><button class="secondary-btn" id="heroRadio">✦ Start smart radio</button></div></div></section>
    <div class="section-head"><div><div class="eyebrow">QUICK DISCOVERY</div><h2>Pick a vibe</h2></div><span>${CONFIG.API_KEY ? 'YouTube connected' : 'Offline library'}</span></div>
    <div class="mood-row">${['Chill','Focus','Workout','Malayalam','Anirudh','Lo-fi','Romantic','Night drive','Trending','A.R. Rahman','K-pop','Instrumental'].map(x => `<button class="mood-chip" data-mood="${attrEsc(x)}">${htmlEsc(x)}</button>`).join('')}</div>
    <div class="rec-banner"><div><strong>${basis ? `More music around ${htmlEsc(basis.slice(0, 55))}${basis.length > 55 ? '…' : ''}` : 'Your discovery feed'}</strong><p>${state.recLoading ? 'Finding fresh tracks…' : 'Personalized from your likes, history and current track.'}</p></div><button class="primary-btn" id="refreshRecs">${state.recLoading ? 'Finding…' : 'Refresh'}</button></div>
    ${renderShelf('FOR YOU', 'Recommended for you', state.recommendations, 'No recommendations yet — connect YouTube or start listening.', 8)}
    ${renderShelf('TRENDING', `Popular in ${htmlEsc(CONFIG.REGION)}`, state.trending, 'Trending tracks will appear here when YouTube is connected.', 8)}
    ${state.current ? renderShelf('KEEP GOING', 'Because you played this', state.recommendations.slice(0, 6), '', 6) : ''}
    ${state.history.length ? renderShelf('RECENT', 'Continue listening', state.history, '', 8) : `<div class="empty" style="margin-top:24px"><div><div class="empty-icon">♪</div><h3>Start your first session</h3><p>Search for an artist, song or vibe. The app will build better recommendations from there.</p></div></div>`}`;
  $('#heroSearch').onclick = () => { $('#searchInput').focus(); showSuggestions(true); };
  $('#heroRadio').onclick = smartRadio;
  $('#refreshRecs').onclick = () => loadRecommendations(true);
  $$('[data-mood]').forEach(b => b.onclick = () => doSearch(`${b.dataset.mood} music`));
  wireCards();
}
function renderShelf(kicker, title, items, emptyText, limit) {
  if (!items.length) return emptyText ? `<div class="section-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2></div></div><div class="shelf-empty">${htmlEsc(emptyText)}</div>` : '';
  return `<div class="section-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2></div><span>${Math.min(limit, items.length)} tracks</span></div><div class="card-grid">${items.slice(0, limit).map(cardHTML).join('')}</div>`;
}
function renderDiscover(c) {
  c.innerHTML = `<div class="eyebrow">DISCOVER</div><h1 class="page-title">Find your next track.</h1>
    <div class="discovery-toolbar">${[['relevance','Relevant'],['date','Newest'],['viewCount','Most viewed'],['rating','Top rated'],['title','Title']].map(([v,l]) => `<button class="filter-chip ${state.searchFilter === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}<button class="filter-chip" id="recommendNow">✦ For you</button></div>
    <div class="discover-status"><span>${state.loading ? 'Searching YouTube…' : state.results.length ? `${state.results.length}${state.totalResults ? ` of ${Number(state.totalResults).toLocaleString()}` : ''} results${state.query ? ` for “${htmlEsc(state.query)}”` : ''}` : 'Search for a song, artist, album or mood.'}</span>${state.error ? `<span class="error-text">${htmlEsc(state.error)}</span>` : ''}</div>
    ${state.results.length ? `<div class="card-grid">${state.results.map(cardHTML).join('')}</div>${state.nextPageToken ? `<div class="load-more"><button class="secondary-btn" id="loadMoreBtn" ${state.loadingMore ? 'disabled' : ''}>${state.loadingMore ? 'Loading…' : 'Load more'}</button></div>` : ''}` : `<div class="empty"><div><div class="empty-icon">⌕</div><h3>Search YouTube</h3><p>Try “Malayalam melody”, “lofi focus”, an artist name or “new music”.</p></div></div>`}`;
  $$('[data-filter]').forEach(b => b.onclick = () => { state.searchFilter = b.dataset.filter; doSearch(state.query || 'music'); });
  $('#recommendNow').onclick = () => { setView('home'); loadRecommendations(true); };
  $('#loadMoreBtn')?.addEventListener('click', () => doSearch(state.query, { append: true }));
  wireCards();
}
function renderLibrary(c) {
  const playlists = Object.entries(state.playlists);
  c.innerHTML = `<div class="eyebrow">LIBRARY</div><h1 class="page-title">Your collection.</h1><p class="page-sub">Everything stays local to this browser unless you make a YouTube request.</p>
    <div class="stats-grid"><div class="stat-card"><strong>${state.liked.length}</strong><span>Liked</span></div><div class="stat-card"><strong>${state.history.length}</strong><span>History</span></div><div class="stat-card"><strong>${playlists.length}</strong><span>Playlists</span></div><div class="stat-card"><strong>${fmt(state.listeningSeconds)}</strong><span>Listening time</span></div></div>
    <div class="section-head"><div><div class="eyebrow">PLAYLISTS</div><h2>Your playlists</h2></div><button class="secondary-btn" id="newLibraryPlaylist">＋ New</button></div>
    ${playlists.length ? `<div class="playlist-grid">${playlists.map(([name,tr]) => `<article class="playlist-card" data-open-playlist="${attrEsc(name)}"><div class="playlist-art">♫</div><div><strong>${htmlEsc(name)}</strong><span>${tr.length} tracks</span></div><button class="icon-btn" data-playlist-menu="${attrEsc(name)}" title="Manage playlist">•••</button></article>`).join('')}</div>` : emptyHTML('No playlists','Create a playlist from any track.')}
    <div class="section-head"><div><div class="eyebrow">BACKUP</div><h2>Library tools</h2></div></div><div class="settings-grid"><button class="setting-card" id="exportData"><strong>Export library</strong><span>Save playlists, likes, queue, history and settings as JSON.</span></button><button class="setting-card" id="importData"><strong>Import library</strong><span>Restore a Shadh Music JSON backup on this device.</span></button></div>`;
  $('#newLibraryPlaylist').onclick = () => createPlaylist();
  $$('[data-open-playlist]').forEach(b => b.onclick = e => { if (!e.target.closest('[data-playlist-menu]')) openPlaylist(b.dataset.openPlaylist); });
  $$('[data-playlist-menu]').forEach(b => b.onclick = e => { e.stopPropagation(); openPlaylist(b.dataset.playlistMenu); });
  $('#exportData').onclick = exportData; $('#importData').onclick = importData; wireCards();
}
function renderCollection(c, title, items, desc) {
  c.innerHTML = `<div class="eyebrow">LIBRARY</div><h1 class="page-title">${htmlEsc(title)}</h1><p class="page-sub">${htmlEsc(desc)}</p>${items.length ? `<div class="card-grid">${items.map(cardHTML).join('')}</div>` : emptyHTML(title, 'Nothing here yet.')}${title === 'Listening history' && items.length ? `<div class="panel-row"><button class="secondary-btn" id="clearHistoryLocal">Clear history</button><button class="secondary-btn" id="clearSearchHistoryLocal">Clear search history</button></div>` : ''}`;
  $('#clearHistoryLocal')?.addEventListener('click', () => { if (!confirmAction('Clear your listening history?')) return; state.history = []; persist(); render(); toast('History cleared'); });
  $('#clearSearchHistoryLocal')?.addEventListener('click', () => clearSearchHistory());
  wireCards();
}
function emptyHTML(h, p) { return `<div class="empty"><div><div class="empty-icon">♪</div><h3>${htmlEsc(h)}</h3><p>${htmlEsc(p)}</p></div></div>`; }

function renderSettings(c) {
  const s = state.settings;
  const tabs = [['general','General'],['playback','Playback'],['appearance','Appearance'],['recommendations','Recommendations'],['youtube','YouTube'],['library','Library'],['keyboard','Keyboard'],['about','About']];
  const tab = settingsTab || 'general';
  let body = '';
  if (tab === 'general') body = `<div class="settings-section"><div class="setting-row"><div><strong>Theme</strong><span>Choose the surface style for the whole app.</span></div><select data-setting="theme"><option value="dark" ${s.theme==='dark'?'selected':''}>OLED Dark</option><option value="light" ${s.theme==='light'?'selected':''}>Light Clay</option><option value="system" ${s.theme==='system'?'selected':''}>System</option></select></div><div class="setting-row"><div><strong>Compact cards</strong><span>Fit more tracks on screen.</span></div>${toggleHTML('compactCards',s.compactCards)}</div><div class="setting-row"><div><strong>Reduced motion</strong><span>Minimize interface animations.</span></div>${toggleHTML('reduceMotion',s.reduceMotion)}</div><div class="setting-row"><div><strong>Show desktop queue</strong><span>Keep the right-side queue visible on wide screens.</span></div>${toggleHTML('showQueue',s.showQueue)}</div></div>`;
  if (tab === 'playback') body = `<div class="settings-section"><div class="setting-row"><div><strong>Autoplay next</strong><span>Move to the next queue track when the current video ends.</span></div>${toggleHTML('autoplayNext',s.autoplayNext)}</div><div class="setting-row"><div><strong>Auto smart radio</strong><span>When the queue ends, use recommendations to keep music going.</span></div>${toggleHTML('autoRadio',s.autoRadio)}</div><div class="setting-row"><div><strong>Pause when tab is hidden</strong><span>Pause YouTube playback when you switch tabs.</span></div>${toggleHTML('pauseWhenHidden',s.pauseWhenHidden)}</div><div class="setting-row"><div><strong>Remember volume</strong><span>Keep your volume and mute choice between sessions.</span></div>${toggleHTML('rememberVolume',s.rememberVolume)}</div><div class="setting-row"><div><strong>Current playback</strong><span>${state.current ? htmlEsc(state.current.title) : 'Nothing playing'}${state.current ? ` · ${htmlEsc(state.current.channel)}` : ''}</span></div><button class="secondary-btn" id="stopPlayback">Stop</button></div></div>`;
  if (tab === 'appearance') body = `<div class="settings-section"><div class="appearance-preview ${currentThemeIsDark()?'dark':''}"><div class="preview-orb"></div><div><div class="eyebrow">PREVIEW</div><strong>Clay + glass surface</strong><p>Minimal controls, deep shadows and soft tactile cards.</p></div></div><div class="setting-grid-three"><button class="setting-card ${s.theme==='dark'?'active':''}" data-theme-choice="dark"><strong>OLED Dark</strong><span>True-dark background and high contrast.</span></button><button class="setting-card ${s.theme==='light'?'active':''}" data-theme-choice="light"><strong>Light Clay</strong><span>Bright claymorphic surface.</span></button><button class="setting-card ${s.theme==='system'?'active':''}" data-theme-choice="system"><strong>System</strong><span>Follow your operating system.</span></button></div></div>`;
  if (tab === 'recommendations') body = `<div class="settings-section"><div class="setting-row"><div><strong>Recommendation style</strong><span>Choose what should influence your discovery feed.</span></div><select data-setting="recommendationMode"><option value="balanced" ${s.recommendationMode==='balanced'?'selected':''}>Balanced</option><option value="current" ${s.recommendationMode==='current'?'selected':''}>Mostly current track</option><option value="liked" ${s.recommendationMode==='liked'?'selected':''}>Mostly liked tracks</option><option value="history" ${s.recommendationMode==='history'?'selected':''}>Mostly listening history</option></select></div><div class="feature-card"><div class="feature-icon">✦</div><div><strong>Smart Radio</strong><p>Builds a queue from the current track, your library and fresh YouTube results.</p></div><button class="primary-btn" id="runRadioSettings">Start</button></div><div class="feature-card"><div class="feature-icon">↻</div><div><strong>Refresh discovery</strong><p>Fetch a fresh personalized batch without changing your library.</p></div><button class="secondary-btn" id="refreshRecSettings">Refresh</button></div></div>`;
  if (tab === 'youtube') body = `<div class="settings-section"><div class="connection-card"><div><div class="eyebrow">YOUTUBE DATA API</div><strong>${CONFIG.API_KEY ? (ytReady ? 'Connected and ready' : 'Key saved') : 'Not connected'}</strong><p>${CONFIG.API_KEY ? 'Live search and recommendation requests are enabled.' : 'Add a browser-restricted YouTube Data API v3 key to enable live search.'}</p></div><span class="connection-dot ${CONFIG.API_KEY?'on':''}"></span></div><div class="setting-row"><div><strong>Region</strong><span>Used for YouTube search and trending discovery.</span></div><select data-setting="region">${['IN','US','GB','AE','CA','AU','DE','FR','JP','KR','SG'].map(x => `<option value="${x}" ${CONFIG.REGION===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="setting-row"><div><strong>Search language</strong><span>Preferred language hint sent with search requests.</span></div><select data-setting="language"><option value="en" ${CONFIG.LANGUAGE==='en'?'selected':''}>English</option><option value="ml" ${CONFIG.LANGUAGE==='ml'?'selected':''}>Malayalam</option><option value="hi" ${CONFIG.LANGUAGE==='hi'?'selected':''}>Hindi</option><option value="ta" ${CONFIG.LANGUAGE==='ta'?'selected':''}>Tamil</option><option value="te" ${CONFIG.LANGUAGE==='te'?'selected':''}>Telugu</option></select></div><div class="panel-row"><button class="secondary-btn" id="testApiSettings">Test connection</button><button class="primary-btn" id="openApiSettings">Manage API key</button></div></div>`;
  if (tab === 'library') body = `<div class="settings-section"><div class="setting-row"><div><strong>Confirm destructive actions</strong><span>Ask before clearing history, resetting data or deleting playlists.</span></div>${toggleHTML('confirmDestructive',s.confirmDestructive)}</div><div class="settings-row-spaced"><button class="setting-card" id="exportSetting"><strong>Export everything</strong><span>Back up your local library and preferences.</span></button><button class="setting-card" id="importSetting"><strong>Import backup</strong><span>Restore a previous Shadh Music backup.</span></button></div><div class="danger-zone"><div><strong>Reset local data</strong><span>Deletes queue, likes, history, playlists and local settings. Your YouTube key is kept until you clear it separately.</span></div><button class="danger-btn" id="resetSetting">Reset</button></div></div>`;
  if (tab === 'keyboard') body = `<div class="settings-section"><div class="shortcut-grid">${[['Space','Play / pause'],['J','Previous track'],['K','Next track'],['M','Mute'],['S','Shuffle'],['R','Repeat mode'],['Q','Now playing'],['/','Focus search'],['← / →','Seek 10s'],['Esc','Close panel']].map(([k,v]) => `<div class="shortcut-item"><kbd>${htmlEsc(k)}</kbd><span>${htmlEsc(v)}</span></div>`).join('')}</div></div>`;
  if (tab === 'about') body = `<div class="settings-section"><div class="about-card"><div class="brand-mark">S</div><div><h3>Shadh Music</h3><p>A local-first music interface built around the official YouTube player and YouTube Data API.</p><span>Version 4.1 · No account required for local features.</span></div></div><div class="feature-list"><div><strong>Local library</strong><span>Queue, likes, history and playlists are stored in this browser.</span></div><div><strong>Recommendations</strong><span>Search-based discovery blends your recent listening with fresh YouTube results.</span></div><div><strong>Playback</strong><span>Playback uses the YouTube IFrame Player API.</span></div></div></div>`;
  c.innerHTML = `<div class="settings-page"><div class="eyebrow">SETTINGS</div><h1 class="page-title">Everything in one place.</h1><p class="page-sub">Tune how Shadh Music looks, behaves and discovers music.</p><div class="settings-layout"><nav class="settings-tabs">${tabs.map(([id,label]) => `<button class="settings-tab ${tab===id?'active':''}" data-settings-tab="${id}">${htmlEsc(label)}</button>`).join('')}</nav><section class="settings-main"><div class="settings-main-head"><div><div class="eyebrow">${htmlEsc(tabs.find(x=>x[0]===tab)?.[1] || 'Settings')}</div><h2>${htmlEsc(tabs.find(x=>x[0]===tab)?.[1] || 'Settings')}</h2></div><span class="settings-saved">Saved automatically</span></div>${body}</section></div></div>`;
  $$('[data-settings-tab]').forEach(b => b.onclick = () => { settingsTab = b.dataset.settingsTab; renderSettings($('#content')); });
  $$('[data-setting]').forEach(el => el.addEventListener('change', () => setSetting(el.dataset.setting, el.type === 'checkbox' ? el.checked : el.value)));
  $$('[data-toggle-setting]').forEach(el => el.onclick = () => setSetting(el.dataset.toggleSetting, el.getAttribute('aria-pressed') !== 'true'));
  $$('[data-theme-choice]').forEach(b => b.onclick = () => { state.settings.theme = b.dataset.themeChoice; persist(); render(); settingsTab = 'appearance'; renderSettings($('#content')); });
  $('#stopPlayback')?.addEventListener('click', stopPlayback);
  $('#runRadioSettings')?.addEventListener('click', smartRadio);
  $('#refreshRecSettings')?.addEventListener('click', () => loadRecommendations(true));
  $('#testApiSettings')?.addEventListener('click', testApiConnection);
  $('#openApiSettings')?.addEventListener('click', openApiSetup);
  $('#exportSetting')?.addEventListener('click', exportData); $('#importSetting')?.addEventListener('click', importData);
  $('#resetSetting')?.addEventListener('click', resetLocalData);
}
let settingsTab = 'general';
function toggleHTML(key, value) { return `<button class="toggle ${value?'on':''}" type="button" aria-pressed="${value?'true':'false'}" data-toggle-setting="${key}" title="Toggle ${key}"><span></span></button>`; }
function setSetting(key, value) {
  if (!(key in state.settings)) return;
  state.settings[key] = key === 'region' || key === 'language' || key === 'recommendationMode' || key === 'theme' ? String(value) : !!value;
  if (key === 'region') CONFIG.REGION = state.settings.region;
  if (key === 'language') CONFIG.LANGUAGE = state.settings.language;
  persist();
  if (key === 'theme') { render(); } else { render(); }
  if (key === 'reduceMotion') toast(value ? 'Reduced motion enabled' : 'Animations restored');
  if (key === 'showQueue') mobileQueueOpen = false;
}
function resetLocalData() {
  if (!confirmAction('Reset all local Shadh Music data?')) return;
  localStorage.removeItem(STORAGE);
  state.queue = []; state.history = []; state.liked = []; state.playlists = Object.fromEntries(DEFAULT_PLAYLISTS.map(x => [x, []])); state.current = null; state.recentSearches = []; state.listeningSeconds = 0; state.settings = { ...DEFAULT_SETTINGS };
  stopPlayback(); persist(); render(); toast('Local data reset');
}

function renderPlayer() {
  const t = state.current;
  $('#playerTitle').textContent = t?.title || 'Nothing playing'; $('#playerChannel').textContent = t?.channel || 'Choose a track to start';
  $('#playerLikeBtn').textContent = t && isLiked(t.id) ? '♥' : '♡';
  $('#playerLikeBtn').setAttribute('aria-pressed', t && isLiked(t.id) ? 'true' : 'false');
  $('#miniArtWrap').innerHTML = t ? `<img class="mini-art" src="${attrEsc(t.thumb)}" alt="">` : `<div class="mini-art placeholder-art">♪</div>`;
  $('#shuffleBtn').classList.toggle('active-control', state.shuffle); $('#repeatBtn').classList.toggle('active-control', state.repeat !== 'off');
  $('#repeatBtn').textContent = state.repeat === 'one' ? '↻1' : '↻'; $('#muteBtn').textContent = state.muted ? '◌' : '◖';
  $('#playPauseBtn').textContent = (ytPlayer && ytReady && ytPlayer.getPlayerState?.() === 1) ? 'Ⅱ' : '▶';
  $('#playerEq').classList.toggle('playing', ytPlayer && ytReady && ytPlayer.getPlayerState?.() === 1);
  setMediaSession();
}
function renderVolume() { const displayed = state.muted ? 0 : state.volume; $('#volumeRange').value = state.volume; $('#volumeRange').style.setProperty('--p', `${displayed}%`); }

function addToQueue(t, play = false) {
  t = normalizeTrack(t); if (!t) return;
  if (!state.queue.some(x => x.id === t.id)) state.queue.push(t);
  persist(); renderQueue(); if (play) playTrack(t); else toast(`${t.title.slice(0, 42)} added to queue`);
}
function toggleLike(t) {
  t = normalizeTrack(t); if (!t) return;
  const exists = isLiked(t.id); state.liked = exists ? state.liked.filter(x => x.id !== t.id) : [t, ...state.liked];
  persist(); render(); toast(exists ? 'Removed from liked' : 'Saved to liked');
}
function playTrack(t) {
  t = normalizeTrack(t); if (!t) return;
  state.current = t;
  if (!state.queue.some(x => x.id === t.id)) state.queue.push(t);
  state.history = [t, ...state.history.filter(x => x.id !== t.id)].slice(0, 150);
  state.currentStartedAt = Date.now(); persist(); renderPlayer(); renderQueue();
  if (ytReady && ytPlayer) {
    try { ytPlayer.loadVideoById({ videoId: t.id, startSeconds: 0 }); }
    catch { try { ytPlayer.loadVideoById(t.id); } catch { toast('Could not start this YouTube track'); } }
  } else toast(ytApiFailed ? 'YouTube player unavailable' : 'YouTube player is loading…');
  startProgress(); setMediaSession(); scheduleRecommendations();
}
function stopPlayback() { try { ytPlayer?.stopVideo?.(); } catch {} state.current = null; state.currentStartedAt = 0; persist(); render(); }
async function nextTrack(force = false) {
  if (state.repeat === 'one' && state.current && !force) { playTrack(state.current); return; }
  const q = state.queue; if (!q.length) { if (state.settings.autoRadio) { await smartRadio(); return; } toast('Queue finished'); return; }
  let idx = q.findIndex(x => x.id === state.current?.id);
  if (idx < 0) { playTrack(q[0]); return; }
  if (state.shuffle && q.length > 1) { let n = idx; while (n === idx) n = Math.floor(Math.random() * q.length); playTrack(q[n]); return; }
  if (idx < q.length - 1) playTrack(q[idx + 1]);
  else if (state.repeat === 'all') playTrack(q[0]);
  else if (state.settings.autoRadio) await smartRadio(true);
  else toast('Queue finished');
}
function prevTrack() {
  if (!state.queue.length || !state.current) return;
  if (ytReady && ytPlayer && ytPlayer.getCurrentTime?.() > 5) { ytPlayer.seekTo(0, true); return; }
  const idx = state.queue.findIndex(x => x.id === state.current.id);
  playTrack(state.queue[Math.max(0, idx - 1)]);
}
function togglePlay() {
  if (!state.current) { $('#searchInput').focus(); toast('Choose a track first'); return; }
  if (!ytReady || !ytPlayer) { toast('YouTube player is still loading'); return; }
  try { const s = ytPlayer.getPlayerState(); if (s === 1) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); } catch { toast('Playback is unavailable'); }
}
function seekBy(delta) { if (!ytReady || !ytPlayer) return; try { ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() + delta), true); } catch {} }
function startProgress() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!ytReady || !ytPlayer) return;
    try {
      const d = Number(ytPlayer.getDuration?.() || 0), c = Number(ytPlayer.getCurrentTime?.() || 0), p = d ? (c / d) * 100 : 0;
      $('#currentTime').textContent = fmt(c); $('#duration').textContent = fmt(d); $('#progressRange').value = Math.round(p * 10); $('#progressRange').style.setProperty('--p', `${p}%`);
      const playing = ytPlayer.getPlayerState?.() === 1; $('#playerEq').classList.toggle('playing', playing);
      if (playing && !document.hidden) state.listeningSeconds += 0.5;
    } catch {}
  }, 500);
  clearInterval(statsTimer);
  statsTimer = setInterval(() => persist(), 30000);
}

async function api(path, params = {}) {
  const key = (CONFIG.API_KEY || '').trim(); if (!key) throw Object.assign(new Error('API_KEY_MISSING'), { code: 'API_KEY_MISSING' });
  const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`); u.searchParams.set('key', key);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v); });
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
  let res, data = {};
  try { res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } }); data = await res.json().catch(() => ({})); }
  catch (err) { clearTimeout(timer); const e = new Error(err.name === 'AbortError' ? 'YouTube request timed out' : 'Network error while contacting YouTube'); e.code = 'NETWORK'; throw e; }
  clearTimeout(timer);
  if (!res.ok || data.error) { const e = new Error(data.error?.message || `YouTube request failed (${res.status})`); e.code = data.error?.errors?.[0]?.reason || res.status; e.status = res.status; throw e; }
  return data;
}
function cacheKey(q, filter, page) { return `${filter}|${q.trim().toLowerCase()}|${page || ''}|${CONFIG.REGION}|${CONFIG.LANGUAGE}`; }
async function doSearch(q, { append = false } = {}) {
  q = String(q || '').trim(); if (!q) return;
  state.query = q; state.view = 'discover'; state.error = '';
  if (!append) { state.loading = true; state.loadingMore = false; state.results = []; state.nextPageToken = ''; }
  else state.loadingMore = true;
  persist(); render();
  try {
    const pageToken = append ? state.nextPageToken : '';
    const key = cacheKey(q, state.searchFilter, pageToken); let data = searchCache.get(key);
    if (!data) {
      data = await api('search', { part: 'snippet', q, type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: CONFIG.RESULTS, order: state.searchFilter, regionCode: CONFIG.REGION, relevanceLanguage: CONFIG.LANGUAGE, safeSearch: 'moderate', pageToken });
      searchCache.set(key, data);
    }
    const found = dedupe((data.items || []).map(trackFromSearch));
    state.results = append ? dedupe([...state.results, ...found]) : found;
    state.nextPageToken = data.nextPageToken || ''; state.totalResults = data.pageInfo?.totalResults || 0; state.loading = false; state.loadingMore = false;
    if (!append) state.recentSearches = [q, ...state.recentSearches.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 20);
    persist(); render(); toast(`${found.length} results loaded`); loadRecommendations(false);
  } catch (e) {
    state.loading = false; state.loadingMore = false; state.results = append ? state.results : []; state.error = apiErrorText(e); render(); toast(state.error);
  }
}
function apiErrorText(e) {
  if (e?.code === 'API_KEY_MISSING') return 'Add a YouTube API key in Settings → YouTube.';
  if (e?.status === 403) return 'YouTube denied this request or the API quota is exhausted.';
  if (e?.status === 400) return 'YouTube rejected the search request. Check the query or API settings.';
  if (e?.code === 'NETWORK') return 'Could not reach YouTube. Check your connection.';
  return e?.message || 'YouTube search failed.';
}

function recommendationSeeds() {
  const liked = state.liked.slice(0, 4).map(t => t.title);
  const history = state.history.slice(0, 4).map(t => t.title);
  const current = state.current ? [state.current.title, `${state.current.channel} music`] : [];
  if (state.settings.recommendationMode === 'current') return [...current, ...liked, ...history];
  if (state.settings.recommendationMode === 'liked') return [...liked, ...current, ...history];
  if (state.settings.recommendationMode === 'history') return [...history, ...current, ...liked];
  return [...current, ...history, ...liked, 'new music'];
}
function scheduleRecommendations() { clearTimeout(scheduleRecommendations.t); scheduleRecommendations.t = setTimeout(() => loadRecommendations(false), 1600); }
async function loadRecommendations(force = false) {
  if (!CONFIG.API_KEY || !navigator.onLine) return;
  const seed = recommendationSeeds()[0] || 'new music';
  const key = `${state.settings.recommendationMode}|${seed.toLowerCase()}|${CONFIG.REGION}|${CONFIG.LANGUAGE}`;
  const freshForMs = 5 * 60 * 1000;
  if (!force && (Date.now() - state.lastRecommendationAt) < freshForMs && (state.recommendations.length || state.trending.length)) return;
  if (!force && state.recommendationKey === key && (state.recommendations.length || state.trending.length)) return;
  state.recommendationKey = key; state.recLoading = true; render();
  try {
    const personalizedQuery = state.current ? `${state.current.title} similar music` : `${seed} music`; 
    const trendingQuery = `${CONFIG.REGION === 'IN' ? 'India' : CONFIG.REGION} trending music`;
    const [personal, trending] = await Promise.all([
      api('search', { part: 'snippet', q: personalizedQuery, type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: 16, order: 'relevance', regionCode: CONFIG.REGION, relevanceLanguage: CONFIG.LANGUAGE, safeSearch: 'moderate' }).catch(() => ({ items: [] })),
      api('search', { part: 'snippet', q: trendingQuery, type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: 12, order: 'viewCount', regionCode: CONFIG.REGION, relevanceLanguage: CONFIG.LANGUAGE, safeSearch: 'moderate' }).catch(() => ({ items: [] }))
    ]);
    const seen = new Set([...state.history, ...state.queue].map(t => t.id));
    state.recommendations = dedupe((personal.items || []).map(trackFromSearch)).filter(t => !seen.has(t.id)).slice(0, 16);
    state.trending = dedupe((trending.items || []).map(trackFromSearch)).slice(0, 12);
    state.lastRecommendationAt = Date.now();
  } catch {}
  state.recLoading = false; persist(); render();
}
async function smartRadio(startImmediately = false) {
  if (!CONFIG.API_KEY) { toast('Connect YouTube first'); return; }
  if (!state.recommendations.length) await loadRecommendations(true);
  const currentId = state.current?.id;
  const candidates = dedupe([...state.recommendations, ...state.trending]).filter(t => t.id !== currentId && !state.queue.some(q => q.id === t.id));
  let picks = candidates.slice(0, 10);
  if (!picks.length) { await loadRecommendations(true); picks = dedupe([...state.recommendations, ...state.trending]).filter(t => t.id !== currentId).slice(0, 10); }
  picks.forEach(t => addToQueue(t));
  if ((!state.current || startImmediately) && picks[0]) playTrack(picks[0]);
  toast(picks.length ? `Smart radio added ${picks.length} tracks` : 'No new radio tracks found');
}

function setupYT() {
  if (ytPlayer || ytApiFailed) return;
  if (!window.YT?.Player) { return; }
  try {
    ytPlayer = new YT.Player('youtubePlayer', { height: '1', width: '1', videoId: state.current?.id || '', playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1 }, events: { onReady: e => { ytReady = true; e.target.setVolume(state.muted ? 0 : state.volume); startProgress(); render(); }, onStateChange: onPlayerStateChange, onError: e => { const map = { 2:'Invalid video ID', 5:'HTML5 player error', 100:'Video unavailable', 101:'Embedding blocked', 150:'Embedding blocked' }; toast(`YouTube: ${map[e.data] || 'Playback error'}`); } } });
  } catch { ytApiFailed = true; toast('Could not initialize the YouTube player'); }
}
function onPlayerStateChange(e) {
  const playing = e.data === 1;
  $('#playPauseBtn').textContent = playing ? 'Ⅱ' : '▶'; $('#playerEq').classList.toggle('playing', playing);
  if (playing) state.currentStartedAt = Date.now();
  if (e.data === 0) nextTrack();
  if (e.data === 2) persist();
}
window.onYouTubeIframeAPIReady = setupYT;
if (window.YT?.Player) setTimeout(setupYT, 0);
function setMediaSession() {
  if (!('mediaSession' in navigator) || !state.current) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: state.current.title, artist: state.current.channel, album: 'Shadh Music', artwork: [{ src: state.current.thumb, sizes: '480x360', type: 'image/jpeg' }] });
    navigator.mediaSession.setActionHandler('play', () => { if (ytPlayer) ytPlayer.playVideo(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (ytPlayer) ytPlayer.pauseVideo(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10));
    navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10));
  } catch {}
}

function openPanel(html) { const panel = $('#utilityPanel'); $('#panelContent').innerHTML = html; panel.hidden = false; setTimeout(() => $('#panelContent input, #panelContent button')?.focus(), 30); }
function closePanel() { $('#utilityPanel').hidden = true; $('#panelContent').innerHTML = ''; }
function openApiSetup() {
  openPanel(`<h3>Connect YouTube</h3><p>Live search and recommendations use your YouTube Data API v3 key. Playback itself uses the official YouTube IFrame Player API.</p><div class="field"><label>API key</label><input id="apiKeyInput" type="password" value="${attrEsc(CONFIG.API_KEY)}" placeholder="AIza…" autocomplete="off"></div><div class="connection-card"><div><strong>${CONFIG.API_KEY ? 'Key saved' : 'No key saved'}</strong><p>For public deployment, restrict the key to the YouTube Data API and your site origin.</p></div><span class="connection-dot ${CONFIG.API_KEY?'on':''}"></span></div><div class="panel-row"><button class="secondary-btn" id="apiClearBtn">Clear</button><button class="primary-btn" id="apiSaveBtn">Save & test</button></div>`);
  $('#apiSaveBtn').onclick = async () => { CONFIG.API_KEY = $('#apiKeyInput').value.trim(); persist(); if (!CONFIG.API_KEY) { closePanel(); toast('YouTube key cleared'); return; } toast('Testing YouTube…'); await testApiConnection(); closePanel(); };
  $('#apiClearBtn').onclick = () => { CONFIG.API_KEY = ''; localStorage.removeItem('shadh_youtube_api_key'); closePanel(); render(); toast('YouTube key cleared'); };
}
async function testApiConnection() {
  if (!CONFIG.API_KEY) { toast('No YouTube API key saved'); return false; }
  try { await api('search', { part:'snippet', q:'music', type:'video', maxResults:1, regionCode:CONFIG.REGION, relevanceLanguage:CONFIG.LANGUAGE }); toast('YouTube connection works'); return true; }
  catch (e) { toast(apiErrorText(e)); return false; }
}
function openProfile() {
  const mins = Math.floor(state.listeningSeconds / 60);
  openPanel(`<h3>Your music stats</h3><p>Local activity from this browser.</p><div class="stats-grid"><div class="stat-card"><strong>${state.history.length}</strong><span>Recent tracks</span></div><div class="stat-card"><strong>${state.liked.length}</strong><span>Liked</span></div><div class="stat-card"><strong>${Object.keys(state.playlists).length}</strong><span>Playlists</span></div><div class="stat-card"><strong>${mins}</strong><span>Minutes played</span></div></div><div class="panel-row"><button class="primary-btn" id="profileSettings">Open settings</button></div>`);
  $('#profileSettings').onclick = () => { closePanel(); setView('settings'); };
}
function openPlaylist(name) {
  const tracks = state.playlists[name] || [];
  openPanel(`<h3>${htmlEsc(name)}</h3><p>${tracks.length} tracks in this playlist.</p>${tracks.length ? `<div class="queue-list playlist-panel-list">${tracks.map((t,i) => `<div class="queue-item"><img class="queue-thumb" src="${attrEsc(t.thumb)}" alt=""><div><div class="queue-title">${escapeTitle(t.title)}</div><div class="queue-sub">${htmlEsc(t.channel)}</div></div><button class="queue-more" data-pl-remove="${i}" data-pl-name="${attrEsc(name)}">×</button></div>`).join('')}</div>` : emptyHTML('Playlist empty','Add tracks from a song card.') }<div class="panel-row"><button class="secondary-btn" id="renamePl">Rename</button><button class="secondary-btn" id="deletePl">Delete</button><button class="primary-btn" id="closePl">Done</button></div>`);
  $('#closePl').onclick = closePanel; $('#renamePl').onclick = () => renamePlaylist(name);
  $('#deletePl').onclick = () => { if (!confirmAction(`Delete playlist “${name}”?`)) return; delete state.playlists[name]; persist(); closePanel(); render(); toast('Playlist deleted'); };
  $$('[data-pl-remove]').forEach(b => b.onclick = () => { state.playlists[b.dataset.plName].splice(+b.dataset.plRemove, 1); persist(); openPlaylist(name); renderSidebar(); });
}
function renamePlaylist(name) {
  openPanel(`<h3>Rename playlist</h3><div class="field"><label>New name</label><input id="renameInput" value="${attrEsc(name)}" maxlength="40"></div><div class="panel-row"><button class="secondary-btn" id="cancelRename">Cancel</button><button class="primary-btn" id="saveRename">Save</button></div>`);
  $('#cancelRename').onclick = closePanel; $('#saveRename').onclick = () => { const next = $('#renameInput').value.trim(); if (!next) return toast('Enter a name'); if (state.playlists[next] && next !== name) return toast('That playlist already exists'); state.playlists[next] = state.playlists[name]; if (next !== name) delete state.playlists[name]; persist(); closePanel(); render(); toast('Playlist renamed'); };
}
function createPlaylist(seed = null) {
  openPanel(`<h3>New playlist</h3><p>Create a local collection you can edit anytime.</p><div class="field"><label>Playlist name</label><input id="plName" maxlength="40" placeholder="Sunday drive"></div><div class="panel-row"><button class="secondary-btn" id="cancelPlCreate">Cancel</button><button class="primary-btn" id="savePlCreate">Create</button></div>`);
  $('#cancelPlCreate').onclick = closePanel; $('#savePlCreate').onclick = () => { const n = $('#plName').value.trim(); if (!n) return toast('Enter a name'); if (state.playlists[n]) return toast('That playlist already exists'); state.playlists[n] = seed ? [seed] : []; persist(); closePanel(); render(); toast(`Created “${n}”`); };
}
function openPlaylistPicker(t) {
  const names = Object.keys(state.playlists);
  openPanel(`<h3>Add to playlist</h3><p>${escapeTitle(t.title)}</p><div class="settings-grid">${names.map(n => `<button class="setting-card" data-pick="${attrEsc(n)}"><strong>${htmlEsc(n)}</strong><span>${state.playlists[n].length} tracks</span></button>`).join('')}</div><div class="panel-row"><button class="secondary-btn" id="newFromPicker">＋ New playlist</button></div>`);
  $$('[data-pick]').forEach(b => b.onclick = () => { const n = b.dataset.pick; if (!state.playlists[n].some(x => x.id === t.id)) { state.playlists[n].push(t); persist(); toast(`Added to ${n}`); } else toast('Already in that playlist'); closePanel(); renderSidebar(); });
  $('#newFromPicker').onclick = () => { closePanel(); createPlaylist(t); };
}
function openSleepTimer() {
  openPanel(`<h3>Sleep timer</h3><p>Stop playback automatically after the selected time.</p><div class="settings-grid">${[10,15,30,45,60,90].map(m => `<button class="setting-card" data-sleep="${m}"><strong>${m} minutes</strong><span>Pause playback</span></button>`).join('')}<button class="setting-card" data-sleep="0"><strong>Off</strong><span>Cancel timer</span></button></div>`);
  $$('[data-sleep]').forEach(b => b.onclick = () => { const m = +b.dataset.sleep; clearTimeout(sleepTimeout); sleepTimeout = m ? setTimeout(() => { try { ytPlayer?.pauseVideo?.(); } catch {} toast('Sleep timer finished'); }, m * 60000) : null; closePanel(); toast(m ? `Sleep timer: ${m} min` : 'Sleep timer off'); });
}
function openNowPlaying() {
  if (!state.current) { toast('Nothing playing'); return; }
  const t = state.current;
  openPanel(`<div class="now-playing"><img class="now-playing-art" src="${attrEsc(t.thumb)}" alt=""><div><div class="eyebrow">NOW PLAYING</div><div class="big-title">${escapeTitle(t.title)}</div><div class="np-channel">${htmlEsc(t.channel)}</div><div class="wave">${Array.from({length:42},(_,i)=>`<i style="animation-delay:${(i%9)*.06}s"></i>`).join('')}</div><div class="panel-row panel-row-start"><button class="secondary-btn" id="openYTNow">Open on YouTube</button><button class="secondary-btn" id="copyNow">Copy link</button><button class="primary-btn" id="npPlay">Play / Pause</button></div></div></div>`);
  $('#npPlay').onclick = togglePlay; $('#openYTNow').onclick = () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(t.id)}`, '_blank', 'noopener,noreferrer'); $('#copyNow').onclick = async () => { try { await navigator.clipboard.writeText(`https://www.youtube.com/watch?v=${encodeURIComponent(t.id)}`); toast('YouTube link copied'); } catch {} };
}
function exportData() {
  const data = { version: 4, exportedAt: new Date().toISOString(), queue: state.queue, history: state.history, liked: state.liked, playlists: state.playlists, current: state.current, shuffle: state.shuffle, repeat: state.repeat, volume: state.volume, muted: state.muted, recentSearches: state.recentSearches, settings: state.settings, listeningSeconds: state.listeningSeconds };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'shadh-music-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('Backup exported');
}
function importData() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json,.json';
  input.onchange = async () => { const f = input.files?.[0]; if (!f) return; try { const d = JSON.parse(await f.text()); if (Array.isArray(d.queue)) state.queue = dedupe(d.queue.map(normalizeTrack)); if (Array.isArray(d.history)) state.history = dedupe(d.history.map(normalizeTrack)); if (Array.isArray(d.liked)) state.liked = dedupe(d.liked.map(normalizeTrack)); if (d.playlists && typeof d.playlists === 'object') state.playlists = Object.fromEntries(Object.entries(d.playlists).map(([k,v]) => [k, dedupe((Array.isArray(v) ? v : []).map(normalizeTrack))])); state.current = normalizeTrack(d.current) || state.current; if (d.settings) state.settings = {...DEFAULT_SETTINGS, ...d.settings}; state.listeningSeconds = Number(d.listeningSeconds || 0); persist(); render(); toast('Backup imported'); } catch { toast('Invalid Shadh Music backup'); } };
  input.click();
}
function clearSearchHistory() { state.recentSearches = []; persist(); if ($('#searchSuggestions')) $('#searchSuggestions').hidden = true; toast('Search history cleared'); }
function showSuggestions(force = false) {
  const box = $('#searchSuggestions'); const q = $('#searchInput').value.trim().toLowerCase();
  const list = q ? state.recentSearches.filter(x => x.toLowerCase().includes(q)).slice(0, 8) : state.recentSearches.slice(0, 8);
  if (!force && !list.length) { box.hidden = true; return; }
  box.innerHTML = `${list.map(x => `<button class="suggestion" data-suggestion="${attrEsc(x)}">◷ ${htmlEsc(x)}<span>Search again</span></button>`).join('')}${state.recentSearches.length ? `<button class="suggestion clear-suggestion" id="clearSearchHistorySuggestion">× Clear search history</button>` : '<div class="suggestion">Try a song, artist, mood or album.</div>'}`;
  box.hidden = false;
  $$('[data-suggestion]', box).forEach(b => b.onclick = () => { $('#searchInput').value = b.dataset.suggestion; box.hidden = true; doSearch(b.dataset.suggestion); });
  $('#clearSearchHistorySuggestion')?.addEventListener('click', e => { e.stopPropagation(); clearSearchHistory(); });
}
function startVoiceSearch() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast('Voice search is not supported in this browser'); return; }
  if (voiceRecognition) { voiceRecognition.stop(); return; }
  voiceRecognition = new SpeechRecognition(); voiceRecognition.lang = `${CONFIG.LANGUAGE}-${CONFIG.REGION}`; voiceRecognition.interimResults = false; voiceRecognition.maxAlternatives = 1;
  voiceRecognition.onstart = () => { $('#voiceSearchBtn').classList.add('recording'); toast('Listening…'); };
  voiceRecognition.onresult = e => { const q = e.results?.[0]?.[0]?.transcript?.trim(); if (q) { $('#searchInput').value = q; doSearch(q); } };
  voiceRecognition.onerror = () => toast('Voice search failed'); voiceRecognition.onend = () => { $('#voiceSearchBtn').classList.remove('recording'); voiceRecognition = null; };
  try { voiceRecognition.start(); } catch { voiceRecognition = null; }
}
function applyVisibilityPolicy() { if (state.settings.pauseWhenHidden && document.hidden && ytReady) try { ytPlayer?.pauseVideo?.(); } catch {} }

// Events
$$('.nav-item[data-view], .mobile-nav [data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
$('#newPlaylistBtn').onclick = () => createPlaylist(); $('#apiBtn').onclick = openApiSetup; $('#profileBtn').onclick = openProfile;
$('#mobileMenuBtn').onclick = () => $('#sidebar').classList.toggle('open'); $('#themeBtn').onclick = () => { const next = currentThemeIsDark() ? 'light' : 'dark'; state.settings.theme = next; persist(); render(); };
$('#sleepBtn').onclick = openSleepTimer; $('#focusSearchBtn').onclick = () => { $('#searchInput').focus(); showSuggestions(true); }; $('#voiceSearchBtn').onclick = startVoiceSearch;
$('#searchClearBtn').onclick = () => { $('#searchInput').value = ''; $('#searchSuggestions').hidden = true; $('#searchInput').focus(); };
$('#searchInput').addEventListener('input', () => { $('#searchClearBtn').style.display = $('#searchInput').value ? 'block' : ''; showSuggestions(false); });
$('#searchInput').addEventListener('focus', () => showSuggestions(false)); $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#searchSuggestions').hidden = true; doSearch(e.target.value); } if (e.key === 'Escape') $('#searchSuggestions').hidden = true; });
document.addEventListener('click', e => { if (!e.target.closest('#searchWrap')) $('#searchSuggestions').hidden = true; if (mobileQueueOpen && !e.target.closest('#queuePanel') && !e.target.closest('#queueToggleBtn')) { mobileQueueOpen = false; renderQueue(); } });
$('#playPauseBtn').onclick = togglePlay; $('#nextBtn').onclick = () => nextTrack(); $('#prevBtn').onclick = prevTrack;
$('#shuffleBtn').onclick = () => { state.shuffle = !state.shuffle; persist(); renderPlayer(); toast(state.shuffle ? 'Shuffle on' : 'Shuffle off'); };
$('#repeatBtn').onclick = () => { state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off'; persist(); renderPlayer(); toast(`Repeat ${state.repeat}`); };
$('#clearQueueBtn').onclick = () => { if (!confirmAction('Clear the entire queue?')) return; state.queue = []; persist(); renderQueue(); toast('Queue cleared'); };
$('#shuffleQueueBtn').onclick = () => { for (let i = state.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]]; } state.shuffle = true; persist(); renderQueue(); renderPlayer(); toast('Queue shuffled'); };
$('#radioQueueBtn').onclick = smartRadio; $('#queueToggleBtn').onclick = () => { mobileQueueOpen = !mobileQueueOpen; renderQueue(); };
$('#nowPlayingBtn').onclick = openNowPlaying; $('#playerMeta').onclick = e => { if (e.target.closest('#playerLikeBtn')) return; openNowPlaying(); }; $('#playerMeta').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('#playerLikeBtn')) { e.preventDefault(); openNowPlaying(); } };
$('#playerLikeBtn').onclick = e => { e.stopPropagation(); if (state.current) toggleLike(state.current); }; $('#playerLikeBtn').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && state.current) { e.preventDefault(); toggleLike(state.current); } };
$('#volumeRange').oninput = e => { state.volume = +e.target.value; state.muted = state.volume === 0; if (ytPlayer && ytReady) ytPlayer.setVolume(state.muted ? 0 : state.volume); if (state.settings.rememberVolume) persist(); renderVolume(); };
$('#muteBtn').onclick = () => { state.muted = !state.muted; if (ytPlayer && ytReady) ytPlayer.setVolume(state.muted ? 0 : state.volume); if (state.settings.rememberVolume) persist(); renderPlayer(); renderVolume(); };
$('#progressRange').addEventListener('change', e => { if (ytPlayer && ytReady) { const d = ytPlayer.getDuration?.() || 0; if (d) ytPlayer.seekTo((+e.target.value / 1000) * d, true); } });
$('#panelClose').onclick = closePanel; document.addEventListener('visibilitychange', applyVisibilityPolicy);
document.addEventListener('keydown', e => { if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return; if (e.key === 'Escape' && !$('#utilityPanel').hidden) { closePanel(); return; } switch (e.key.toLowerCase()) { case ' ': e.preventDefault(); togglePlay(); break; case 'j': prevTrack(); break; case 'k': nextTrack(); break; case 'm': $('#muteBtn').click(); break; case 's': $('#shuffleBtn').click(); break; case 'r': $('#repeatBtn').click(); break; case 'q': openNowPlaying(); break; case '/': e.preventDefault(); $('#searchInput').focus(); showSuggestions(true); break; case 'arrowleft': seekBy(-10); break; case 'arrowright': seekBy(10); break; } });

if (systemThemeMedia?.addEventListener) systemThemeMedia.addEventListener('change', () => { if (state.settings.theme === 'system') render(); });
render(); renderVolume();
setTimeout(() => { if (!window.YT?.Player && !ytPlayer) toast(CONFIG.API_KEY ? 'YouTube player is loading…' : 'Connect YouTube for live search'); setupYT(); }, 500);
setTimeout(() => loadRecommendations(false), 1200);
