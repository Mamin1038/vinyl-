/**
 * app.js
 * -------------------------------------------------------------
 * 앱의 UI 로직 전체 (뷰 라우팅, 렌더링, 이벤트 바인딩)를 담당한다.
 * storage.js / player.js / metadata.js / lyrics.js가 준비되어 있다고 가정한다.
 * -------------------------------------------------------------
 */

(() => {
  'use strict';

  const storage = window.AppStorage;
  let player = null;

  /** 메모리 상의 라이브러리 캐시. storage가 정본이며 이건 렌더링용 캐시일 뿐. */
  const state = {
    songs: new Map(),        // id -> song record (blob 제외 메타)
    playlists: new Map(),    // id -> playlist
    artworkUrls: new Map(),  // songId -> object URL (앨범아트 표시용)
    currentLibTab: 'songs',
    currentAlbumKey: null,
    currentPlaylistId: null,
    currentArtist: null,
    fpMode: 'art',           // 'art' | 'lp' | 'lyrics'
    lrcEntries: null,
    activeLyricLine: -1,
    pendingSongForSheet: null,
    installShown: false,
  };

  // ---------------------------------------------------------------
  // 유틸
  // ---------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const byId = (id) => document.getElementById(id);

  function formatDuration(sec) {
    if (!sec || !isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function uid() {
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // 곡 id 기반 결정적 그라디언트 (앨범아트 placeholder용)
  const GRADIENT_PAIRS = [
    ['#5b4a3f', '#2a231d'], ['#3f4a52', '#1c2226'], ['#4a3f52', '#221c26'],
    ['#3f5245', '#1c261f'], ['#52433f', '#26201c'], ['#41475b', '#1d202a'],
    ['#5b3f4a', '#261c21'], ['#3f524a', '#1c2622'],
  ];
  function gradientForId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return GRADIENT_PAIRS[hash % GRADIENT_PAIRS.length];
  }
  function placeholderArtDataUrl(id, size = 300) {
    const [c1, c2] = gradientForId(id || 'x');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <g opacity="0.55" transform="translate(${size/2},${size/2})">
        <circle r="${size*0.16}" fill="none" stroke="#f5f3ef" stroke-width="${size*0.018}"/>
        <circle r="${size*0.03}" fill="#f5f3ef"/>
      </g>
    </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  function getArtUrl(song) {
    if (!song) return placeholderArtDataUrl('x');
    if (state.artworkUrls.has(song.id)) return state.artworkUrls.get(song.id);
    if (song.artwork) {
      try {
        const url = URL.createObjectURL(song.artwork);
        state.artworkUrls.set(song.id, url);
        return url;
      } catch { /* fallthrough */ }
    }
    const ph = placeholderArtDataUrl(song.id);
    state.artworkUrls.set(song.id, ph);
    return ph;
  }

  function toast(message, opts = {}) {
    const stack = byId('toast-stack');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.error ? ' error' : '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }, opts.duration || 2600);
  }

  function showModal(id) { byId(id).classList.add('open'); byId(id).setAttribute('aria-hidden', 'false'); }
  function hideModal(id) { byId(id).classList.remove('open'); byId(id).setAttribute('aria-hidden', 'true'); }
  function showSheet(id) { byId(id).classList.add('open'); byId(id).setAttribute('aria-hidden', 'false'); }
  function hideSheet(id) { byId(id).classList.remove('open'); byId(id).setAttribute('aria-hidden', 'true'); }

  function promptDialog(title, defaultValue = '') {
    return new Promise((resolve) => {
      byId('prompt-modal-title').textContent = title;
      const input = byId('prompt-modal-input');
      input.value = defaultValue;
      showModal('prompt-modal');
      setTimeout(() => input.focus(), 200);
      const confirmBtn = byId('prompt-modal-confirm');
      const cleanup = () => {
        confirmBtn.onclick = null;
        hideModal('prompt-modal');
      };
      confirmBtn.onclick = () => {
        const v = input.value.trim();
        cleanup();
        resolve(v || null);
      };
      $$('#prompt-modal [data-close-modal]').forEach((b) => {
        b.onclick = () => { cleanup(); resolve(null); };
      });
    });
  }

  function confirmDialog(title, desc, confirmLabel = '삭제') {
    return new Promise((resolve) => {
      byId('confirm-modal-title').textContent = title;
      byId('confirm-modal-desc').textContent = desc;
      const confirmBtn = byId('confirm-modal-confirm');
      confirmBtn.textContent = confirmLabel;
      showModal('confirm-modal');
      const cleanup = () => { confirmBtn.onclick = null; hideModal('confirm-modal'); };
      confirmBtn.onclick = () => { cleanup(); resolve(true); };
      $$('#confirm-modal [data-close-modal]').forEach((b) => {
        b.onclick = () => { cleanup(); resolve(false); };
      });
    });
  }

  // ---------------------------------------------------------------
  // 뷰 라우팅
  // ---------------------------------------------------------------
  const viewHistory = ['home'];

  function showView(name) {
    $$('.view').forEach((v) => v.classList.remove('active'));
    const el = document.querySelector(`.view[data-view="${name}"]`);
    if (el) el.classList.add('active');
    byId('main-scroll').scrollTop = 0;
    if (['home', 'library', 'search', 'settings'].includes(name)) {
      $$('.tab-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      viewHistory.length = 0;
      viewHistory.push(name);
    } else {
      viewHistory.push(name);
    }
  }

  function goBack() {
    if (viewHistory.length > 1) {
      viewHistory.pop();
      const prev = viewHistory[viewHistory.length - 1];
      $$('.view').forEach((v) => v.classList.remove('active'));
      document.querySelector(`.view[data-view="${prev}"]`).classList.add('active');
      $$('.tab-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === prev));
    } else {
      showView('home');
    }
  }

  $$('.tab-item').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.tab));
  });
  $$('[data-back]').forEach((btn) => btn.addEventListener('click', goBack));
  byId('btn-open-search').addEventListener('click', () => { showView('search'); setTimeout(() => byId('search-input').focus(), 150); });

  // ---------------------------------------------------------------
  // 데이터 로드 / 인덱싱
  // ---------------------------------------------------------------
  async function reloadLibrary() {
    const songs = await storage.getAllSongs();
    state.songs.clear();
    for (const s of songs) {
      const { blob, ...meta } = s; // blob은 캐시에 보관하지 않음(메모리 절약)
      state.songs.set(s.id, s.opfsPath ? meta : { ...meta, artwork: s.artwork, blob: s.blob });
    }
    // artwork는 각 song 레코드에 이미 Blob으로 들어있음 (metadata 추출 시 저장)
    for (const s of songs) {
      const rec = state.songs.get(s.id);
      rec.artwork = s.artwork || null;
    }
    const playlists = await storage.getAllPlaylists();
    state.playlists.clear();
    for (const p of playlists) state.playlists.set(p.id, p);
  }

  function allSongsSorted(sortFn) {
    return Array.from(state.songs.values()).sort(sortFn);
  }

  function albumKey(song) {
    return `${song.albumArtist || song.artist || ''}::${song.album || ''}`;
  }

  function groupByAlbum() {
    const map = new Map();
    for (const s of state.songs.values()) {
      const key = albumKey(s);
      if (!map.has(key)) map.set(key, { key, album: s.album, artist: s.albumArtist || s.artist, songs: [] });
      map.get(key).songs.push(s);
    }
    for (const g of map.values()) {
      g.songs.sort((a, b) => (a.discNumber || 0) - (b.discNumber || 0) || (a.trackNumber || 0) - (b.trackNumber || 0) || a.title.localeCompare(b.title));
    }
    return Array.from(map.values()).sort((a, b) => a.album.localeCompare(b.album));
  }

  function groupByArtist() {
    const map = new Map();
    for (const s of state.songs.values()) {
      const key = s.artist || '알 수 없는 아티스트';
      if (!map.has(key)) map.set(key, { name: key, songs: [] });
      map.get(key).songs.push(s);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------
  // 렌더링: 곡 행 / 앨범 카드
  // ---------------------------------------------------------------
  function renderSongRow(song, opts = {}) {
    const row = document.createElement('div');
    row.className = 'song-row';
    row.dataset.songId = song.id;
    if (player && player.currentSong && player.currentSong.id === song.id) row.classList.add('playing');

    const indexHtml = opts.index != null ? `<div class="song-row-index">${opts.index}</div>` : '';
    row.innerHTML = `
      ${indexHtml}
      <div class="song-row-art"><img src="${getArtUrl(song)}" alt="" loading="lazy" /></div>
      <div class="song-row-text">
        <div class="song-row-title">${escapeHtml(song.title)}</div>
        <div class="song-row-sub">${escapeHtml(song.artist)}${song.album ? ' · ' + escapeHtml(song.album) : ''}</div>
      </div>
      ${song.favorite ? '<div class="song-row-favorite">♥</div>' : ''}
      <div class="song-row-duration">${formatDuration(song.duration)}</div>
      <button class="song-row-more" aria-label="더보기">⋯</button>
    `;
    row.querySelector('.song-row-more').addEventListener('click', (e) => {
      e.stopPropagation();
      openSongActionsSheet(song, opts.queue || null);
    });
    row.addEventListener('click', () => {
      const queue = opts.queue || allSongsSorted((a, b) => a.title.localeCompare(b.title)).map((s) => s.id);
      player.playSongNow(song.id, queue);
    });
    return row;
  }

  function renderAlbumCard(group) {
    const card = document.createElement('div');
    card.className = 'album-card';
    const cover = group.songs.find((s) => s.artwork) || group.songs[0];
    card.innerHTML = `
      <div class="album-card-art"><img src="${getArtUrl(cover)}" alt="" loading="lazy" /></div>
      <div class="album-card-title">${escapeHtml(group.album)}</div>
      <div class="album-card-sub">${escapeHtml(group.artist)}</div>
    `;
    card.addEventListener('click', () => openAlbum(group.key));
    return card;
  }

  // ---------------------------------------------------------------
  // 홈
  // ---------------------------------------------------------------
  function renderHome() {
    const hour = new Date().getHours();
    byId('greeting-text').textContent = hour < 12 ? '좋은 아침이에요' : hour < 18 ? '좋은 오후예요' : '좋은 저녁이에요';

    const hasSongs = state.songs.size > 0;
    byId('home-empty').hidden = hasSongs;
    byId('recent-played-block').hidden = !hasSongs;
    byId('recent-added-block').hidden = !hasSongs;
    if (!hasSongs) return;

    const recentPlayed = allSongsSorted((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)).filter((s) => s.lastPlayedAt).slice(0, 10);
    const playedList = byId('recent-played-list');
    playedList.innerHTML = '';
    byId('recent-played-block').hidden = recentPlayed.length === 0;
    for (const s of recentPlayed) {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.innerHTML = `<div class="album-card-art"><img src="${getArtUrl(s)}" alt="" /></div>
        <div class="album-card-title">${escapeHtml(s.title)}</div>
        <div class="album-card-sub">${escapeHtml(s.artist)}</div>`;
      card.addEventListener('click', () => player.playSongNow(s.id, recentPlayed.map((x) => x.id)));
      playedList.appendChild(card);
    }

    const recentAdded = allSongsSorted((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 15);
    const addedList = byId('recent-added-list');
    addedList.innerHTML = '';
    const queueIds = recentAdded.map((s) => s.id);
    for (const s of recentAdded) addedList.appendChild(renderSongRow(s, { queue: queueIds }));
  }

  // ---------------------------------------------------------------
  // 라이브러리
  // ---------------------------------------------------------------
  function renderLibrary() {
    const hasSongs = state.songs.size > 0;
    byId('library-empty').hidden = hasSongs;
    ['songs', 'albums', 'artists', 'playlists'].forEach((tab) => {
      byId(`lib-panel-${tab}`).hidden = !hasSongs && tab !== 'playlists' ? true : state.currentLibTab !== tab;
    });
    if (!hasSongs && state.currentLibTab !== 'playlists') return;

    if (state.currentLibTab === 'songs') {
      const list = byId('library-song-list');
      list.innerHTML = '';
      const sorted = allSongsSorted((a, b) => a.title.localeCompare(b.title));
      const ids = sorted.map((s) => s.id);
      for (const s of sorted) list.appendChild(renderSongRow(s, { queue: ids }));
    } else if (state.currentLibTab === 'albums') {
      const grid = byId('library-album-grid');
      grid.innerHTML = '';
      for (const g of groupByAlbum()) grid.appendChild(renderAlbumCard(g));
    } else if (state.currentLibTab === 'artists') {
      const list = byId('library-artist-list');
      list.innerHTML = '';
      for (const a of groupByArtist()) {
        const row = document.createElement('div');
        row.className = 'simple-row';
        row.innerHTML = `<div class="simple-row-icon">🎤</div>
          <div><div class="simple-row-title">${escapeHtml(a.name)}</div><div class="simple-row-sub">${a.songs.length}곡</div></div>
          <div class="simple-row-chev">›</div>`;
        row.addEventListener('click', () => openArtist(a.name));
        list.appendChild(row);
      }
    } else if (state.currentLibTab === 'playlists') {
      renderPlaylistList();
    }
  }

  function renderPlaylistList() {
    const list = byId('library-playlist-list');
    list.innerHTML = '';
    const playlists = Array.from(state.playlists.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const p of playlists) {
      const row = document.createElement('div');
      row.className = 'simple-row';
      const heartIcon = p.id === 'favorites' ? '♥' : '🎵';
      row.innerHTML = `<div class="simple-row-icon">${heartIcon}</div>
        <div><div class="simple-row-title">${escapeHtml(p.name)}</div><div class="simple-row-sub">${p.songIds.length}곡</div></div>
        <div class="simple-row-chev">›</div>`;
      row.addEventListener('click', () => openPlaylist(p.id));
      list.appendChild(row);
    }
  }

  $$('#library-tabs .segmented-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#library-tabs .segmented-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentLibTab = btn.dataset.libTab;
      renderLibrary();
    });
  });

  byId('btn-empty-add').addEventListener('click', () => byId('file-input').click());
  byId('btn-empty-add-2').addEventListener('click', () => byId('file-input').click());
  byId('btn-add-music').addEventListener('click', () => byId('file-input').click());

  // ---------------------------------------------------------------
  // 앨범 상세
  // ---------------------------------------------------------------
  function openAlbum(key) {
    const group = groupByAlbum().find((g) => g.key === key);
    if (!group) return;
    state.currentAlbumKey = key;
    const cover = group.songs.find((s) => s.artwork) || group.songs[0];
    byId('album-art-img').src = getArtUrl(cover);
    byId('album-title-text').textContent = group.album;
    byId('album-sub-text').textContent = `${group.artist} · ${group.songs.length}곡`;
    const list = byId('album-track-list');
    list.innerHTML = '';
    const ids = group.songs.map((s) => s.id);
    group.songs.forEach((s, i) => list.appendChild(renderSongRow(s, { index: i + 1, queue: ids })));
    byId('btn-play-album').onclick = () => player.playQueue(ids, 0);
    byId('btn-shuffle-album').onclick = () => {
      if (!player.shuffle) player.toggleShuffle();
      player.playQueue(ids, Math.floor(Math.random() * ids.length));
    };
    showView('album');
  }

  // ---------------------------------------------------------------
  // 아티스트 상세
  // ---------------------------------------------------------------
  function openArtist(name) {
    state.currentArtist = name;
    const group = groupByArtist().find((g) => g.name === name);
    if (!group) return;
    byId('artist-title-text').textContent = name;
    byId('artist-sub-text').textContent = `${group.songs.length}곡`;
    const list = byId('artist-track-list');
    list.innerHTML = '';
    const sorted = group.songs.slice().sort((a, b) => a.title.localeCompare(b.title));
    const ids = sorted.map((s) => s.id);
    sorted.forEach((s) => list.appendChild(renderSongRow(s, { queue: ids })));
    showView('artist');
  }

  // ---------------------------------------------------------------
  // 플레이리스트
  // ---------------------------------------------------------------
  async function createPlaylist(name) {
    const p = { id: uid(), name, songIds: [], createdAt: Date.now(), updatedAt: Date.now() };
    await storage.savePlaylist(p);
    state.playlists.set(p.id, p);
    return p;
  }

  byId('btn-new-playlist').addEventListener('click', async () => {
    const name = await promptDialog('플레이리스트 이름');
    if (!name) return;
    await createPlaylist(name);
    renderPlaylistList();
    toast('플레이리스트를 만들었어요');
  });

  function openPlaylist(id) {
    const p = state.playlists.get(id);
    if (!p) return;
    state.currentPlaylistId = id;
    byId('playlist-title-text').textContent = p.name;
    byId('playlist-sub-text').textContent = `${p.songIds.length}곡`;
    const artWrap = byId('playlist-art-wrap');
    const coverSong = p.songIds.map((id2) => state.songs.get(id2)).find((s) => s && s.artwork);
    if (coverSong) {
      artWrap.innerHTML = `<img src="${getArtUrl(coverSong)}" style="width:100%;height:100%;object-fit:cover" alt=""/>`;
    } else {
      artWrap.innerHTML = p.id === 'favorites' ? '♥' : '🎵';
    }
    const list = byId('playlist-track-list');
    list.innerHTML = '';
    const songs = p.songIds.map((sid) => state.songs.get(sid)).filter(Boolean);
    byId('playlist-empty').hidden = songs.length > 0;
    songs.forEach((s, i) => {
      const row = renderSongRow(s, { index: i + 1, queue: p.songIds });
      list.appendChild(row);
    });
    byId('btn-play-playlist').onclick = () => player.playQueue(p.songIds, 0);
    byId('btn-rename-playlist').onclick = async () => {
      const name = await promptDialog('플레이리스트 이름', p.name);
      if (!name) return;
      p.name = name; p.updatedAt = Date.now();
      await storage.savePlaylist(p);
      openPlaylist(id);
      renderPlaylistList();
    };
    byId('btn-delete-playlist').onclick = async () => {
      const ok = await confirmDialog('플레이리스트 삭제', `"${p.name}"을(를) 삭제할까요? 곡 자체는 삭제되지 않습니다.`);
      if (!ok) return;
      await storage.deletePlaylist(id);
      state.playlists.delete(id);
      renderPlaylistList();
      goBack();
      toast('플레이리스트를 삭제했어요');
    };
    showView('playlist');
  }

  async function ensureFavoritesPlaylist() {
    let fav = Array.from(state.playlists.values()).find((p) => p.id === 'favorites');
    if (!fav) {
      fav = { id: 'favorites', name: 'Favorites', songIds: [], createdAt: Date.now(), updatedAt: Date.now() };
      await storage.savePlaylist(fav);
      state.playlists.set(fav.id, fav);
    }
    return fav;
  }

  // ---------------------------------------------------------------
  // 검색
  // ---------------------------------------------------------------
  const searchInput = byId('search-input');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    byId('search-clear').hidden = q.length === 0;
    byId('search-empty').hidden = q.length !== 0;
    const resultsEl = byId('search-results');
    resultsEl.innerHTML = '';
    if (!q) return;
    const matches = allSongsSorted((a, b) => a.title.localeCompare(b.title)).filter((s) =>
      s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q) || (s.album || '').toLowerCase().includes(q)
    );
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state subtle"><p>검색 결과가 없어요.</p></div>';
      return;
    }
    const ids = matches.map((s) => s.id);
    for (const s of matches) resultsEl.appendChild(renderSongRow(s, { queue: ids }));
  });
  byId('search-clear').addEventListener('click', () => {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });

  // ---------------------------------------------------------------
  // 음악 추가 (import)
  // ---------------------------------------------------------------
  byId('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    await importFiles(files);
  });

  async function importFiles(files) {
    byId('progress-modal-title').textContent = '음악 가져오는 중…';
    byId('progress-fill').style.width = '0%';
    byId('progress-modal-desc').textContent = `0 / ${files.length}`;
    showModal('progress-modal');

    let success = 0, failed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!window.MetadataParser.SUPPORTED_EXTENSIONS.includes(ext)) {
        failed++;
        console.error(`[import] 지원하지 않는 형식: ${file.name}`);
        byId('progress-fill').style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
        byId('progress-modal-desc').textContent = `${i + 1} / ${files.length}`;
        continue;
      }
      try {
        const meta = await window.MetadataParser.extractMetadata(file);
        const id = uid();
        const tempUrl = URL.createObjectURL(file);
        const duration = await window.MetadataParser.getAudioDuration(tempUrl);
        URL.revokeObjectURL(tempUrl);

        const record = {
          id,
          fileName: meta.fileName,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          albumArtist: meta.albumArtist,
          duration,
          trackNumber: meta.trackNumber,
          discNumber: meta.discNumber,
          mimeType: meta.mimeType,
          size: meta.size,
          artwork: meta.artwork || null,
          lyrics: meta.lyrics || null,
          lyricsType: meta.lyrics ? (window.LyricsEngine.looksLikeLRC(meta.lyrics) ? 'lrc' : 'plain') : null,
          addedAt: Date.now(),
          lastPlayedAt: null,
          playCount: 0,
          favorite: false,
        };
        await storage.addSong(record, file);
        success++;
      } catch (err) {
        console.error(`[import] ${file.name} 가져오기 실패:`, err);
        failed++;
        if (err instanceof StorageError && /저장 공간/.test(err.message)) {
          toast(err.message, { error: true, duration: 4000 });
        }
      }
      byId('progress-fill').style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
      byId('progress-modal-desc').textContent = `${i + 1} / ${files.length}`;
    }

    await reloadLibrary();
    renderAll();
    hideModal('progress-modal');
    if (success > 0) toast(`${success}곡을 추가했어요${failed ? ` (${failed}곡 실패)` : ''}`);
    else if (failed > 0) toast('음악을 추가하지 못했어요. 지원하는 형식인지 확인해주세요.', { error: true });
  }

  // ---------------------------------------------------------------
  // 곡 액션 시트 (더보기)
  // ---------------------------------------------------------------
  function openSongActionsSheet(song, contextQueue) {
    state.pendingSongForSheet = { song, contextQueue };
    const header = byId('song-actions-header');
    header.innerHTML = `<img src="${getArtUrl(song)}" alt=""/>
      <div><div class="t">${escapeHtml(song.title)}</div><div class="s">${escapeHtml(song.artist)}</div></div>`;
    byId('action-toggle-favorite').textContent = song.favorite ? '좋아하는 곡에서 제거' : '좋아하는 곡으로 표시';
    showSheet('song-actions-sheet');
  }

  byId('action-play-next').addEventListener('click', () => {
    const { song } = state.pendingSongForSheet;
    if (player.currentSong) {
      const q = player.queue;
      const insertAt = player.currentIndex + 1;
      q.splice(insertAt, 0, song.id);
      player.shuffledQueue = player.shuffle ? player.shuffledQueue : [...q];
      player._emit('queuechange', { queue: q });
      toast('다음 곡으로 추가했어요');
    } else {
      player.playSongNow(song.id, [song.id]);
    }
    hideSheet('song-actions-sheet');
  });
  byId('action-add-queue').addEventListener('click', () => {
    const { song } = state.pendingSongForSheet;
    if (player.currentSong) {
      player.queue.push(song.id);
      if (!player.shuffle) player.shuffledQueue.push(song.id);
      player._emit('queuechange', { queue: player.queue });
      toast('재생목록에 추가했어요');
    } else {
      player.playSongNow(song.id, [song.id]);
    }
    hideSheet('song-actions-sheet');
  });
  byId('action-toggle-favorite').addEventListener('click', async () => {
    const { song } = state.pendingSongForSheet;
    const fav = await ensureFavoritesPlaylist();
    const newFav = !song.favorite;
    await storage.updateSong(song.id, { favorite: newFav });
    if (newFav && !fav.songIds.includes(song.id)) fav.songIds.push(song.id);
    if (!newFav) fav.songIds = fav.songIds.filter((id) => id !== song.id);
    fav.updatedAt = Date.now();
    await storage.savePlaylist(fav);
    await reloadLibrary();
    renderAll();
    hideSheet('song-actions-sheet');
    toast(newFav ? '좋아하는 곡으로 표시했어요' : '좋아하는 곡에서 제거했어요');
  });
  byId('action-add-lyrics').addEventListener('click', () => {
    const { song } = state.pendingSongForSheet;
    hideSheet('song-actions-sheet');
    openLyricsEditSheet(song);
  });
  byId('action-add-playlist').addEventListener('click', () => {
    const { song } = state.pendingSongForSheet;
    hideSheet('song-actions-sheet');
    openAddToPlaylistSheet(song);
  });
  byId('action-delete-song').addEventListener('click', async () => {
    const { song } = state.pendingSongForSheet;
    hideSheet('song-actions-sheet');
    const ok = await confirmDialog('곡 삭제', `"${song.title}"을(를) 라이브러리에서 삭제할까요? 이 작업은 되돌릴 수 없습니다.`);
    if (!ok) return;
    await storage.deleteSong(song.id);
    for (const p of state.playlists.values()) {
      if (p.songIds.includes(song.id)) {
        p.songIds = p.songIds.filter((id) => id !== song.id);
        await storage.savePlaylist(p);
      }
    }
    await reloadLibrary();
    renderAll();
    toast('곡을 삭제했어요');
  });

  function openAddToPlaylistSheet(song) {
    const list = byId('add-to-playlist-list');
    list.innerHTML = '';
    for (const p of state.playlists.values()) {
      const inIt = p.songIds.includes(song.id);
      const row = document.createElement('div');
      row.className = 'simple-row';
      row.innerHTML = `<div class="simple-row-icon">${p.id === 'favorites' ? '♥' : '🎵'}</div>
        <div><div class="simple-row-title">${escapeHtml(p.name)}</div><div class="simple-row-sub">${p.songIds.length}곡</div></div>
        <div class="simple-row-chev">${inIt ? '✓' : ''}</div>`;
      row.addEventListener('click', async () => {
        if (!inIt) {
          p.songIds.push(song.id);
          p.updatedAt = Date.now();
          await storage.savePlaylist(p);
          toast(`"${p.name}"에 추가했어요`);
        }
        hideSheet('add-to-playlist-sheet');
      });
      list.appendChild(row);
    }
    showSheet('add-to-playlist-sheet');
  }
  byId('btn-create-and-add').addEventListener('click', async () => {
    const name = await promptDialog('플레이리스트 이름');
    if (!name) return;
    const p = await createPlaylist(name);
    const song = state.pendingSongForSheet.song;
    p.songIds.push(song.id);
    await storage.savePlaylist(p);
    hideSheet('add-to-playlist-sheet');
    toast(`"${name}"에 추가했어요`);
  });

  // ---------------------------------------------------------------
  // 가사 편집 시트
  // ---------------------------------------------------------------
  let lyricsEditingSong = null;
  function openLyricsEditSheet(song) {
    lyricsEditingSong = song;
    byId('lyrics-textarea').value = song.lyrics || '';
    showSheet('lyrics-edit-sheet');
  }
  byId('btn-save-lyrics').addEventListener('click', async () => {
    const text = byId('lyrics-textarea').value;
    const lyricsType = window.LyricsEngine.looksLikeLRC(text) ? 'lrc' : 'plain';
    await storage.updateSong(lyricsEditingSong.id, { lyrics: text || null, lyricsType: text ? lyricsType : null });
    await reloadLibrary();
    if (player.currentSong && player.currentSong.id === lyricsEditingSong.id) {
      player.currentSong = state.songs.get(lyricsEditingSong.id);
      setupLyricsForCurrentSong();
    }
    hideSheet('lyrics-edit-sheet');
    toast('가사를 저장했어요');
  });
  byId('btn-import-lrc').addEventListener('click', () => byId('lrc-input').click());
  byId('lrc-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    byId('lyrics-textarea').value = text;
  });

  // ---------------------------------------------------------------
  // 바텀시트 공통 닫기 / 큐 시트
  // ---------------------------------------------------------------
  $$('[data-close-sheet]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const sheet = e.target.closest('.bottom-sheet');
      if (sheet) hideSheet(sheet.id);
    });
  });
  $$('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) hideModal(modal.id);
    });
  });

  byId('fp-queue-btn').addEventListener('click', () => {
    renderQueueSheet();
    showSheet('queue-sheet');
  });
  function renderQueueSheet() {
    const list = byId('queue-list');
    list.innerHTML = '';
    if (!player.currentSong) return;
    const q = player.activeQueue;
    q.forEach((sid, idx) => {
      const s = state.songs.get(sid);
      if (!s) return;
      const row = renderSongRow(s, { index: idx === player.currentIndex ? '▶' : idx + 1 });
      if (idx === player.currentIndex) row.classList.add('playing');
      row.addEventListener('click', () => { player.playQueue(q, idx); hideSheet('queue-sheet'); }, { once: true });
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------
  // 설정 화면
  // ---------------------------------------------------------------
  async function renderSettings() {
    const songs = Array.from(state.songs.values());
    byId('settings-song-count').textContent = `${songs.length}곡`;
    const totalBytes = songs.reduce((sum, s) => sum + (s.size || 0), 0);
    byId('settings-music-size').textContent = window.formatBytes(totalBytes);

    const estimate = await storage.getStorageEstimate();
    if (estimate.supported && estimate.quota) {
      byId('settings-quota').textContent = `${window.formatBytes(estimate.usage)} / ${window.formatBytes(estimate.quota)}`;
      byId('storage-bar-fill').style.width = `${Math.min(100, (estimate.usage / estimate.quota) * 100)}%`;
    } else {
      byId('settings-quota').textContent = '확인 불가';
      byId('storage-bar-fill').style.width = '0%';
    }

    const persistResult = await storage.requestPersistence();
    if (persistResult.supported) {
      byId('settings-persist-badge').textContent = persistResult.persisted ? 'Protected' : 'Browser managed';
      byId('settings-persist-desc').textContent = persistResult.persisted
        ? '브라우저가 이 데이터를 임의로 삭제하지 않도록 보호를 요청했어요.'
        : '브라우저가 저장 공간이 부족할 때 데이터를 정리할 수 있어요. 정기적으로 백업하는 것을 권장해요.';
    } else {
      byId('settings-persist-badge').textContent = '지원 안됨';
      byId('settings-persist-desc').textContent = '이 브라우저는 저장소 보호 요청을 지원하지 않아요. 백업을 자주 해주세요.';
    }

    byId('settings-storage-mode-desc').textContent = storage.opfsAvailable
      ? 'OPFS(파일 시스템)에 오디오 파일을 저장하고 있어요.'
      : 'IndexedDB에 오디오 데이터를 저장하고 있어요. (이 브라우저는 OPFS를 지원하지 않거나 제한적으로 지원해요)';
  }

  byId('btn-backup').addEventListener('click', async () => {
    if (state.songs.size === 0) { toast('백업할 음악이 없어요'); return; }
    byId('progress-modal-title').textContent = '백업 만드는 중…';
    byId('progress-fill').style.width = '0%';
    showModal('progress-modal');
    try {
      const backup = await storage.exportBackup((done, total) => {
        byId('progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
        byId('progress-modal-desc').textContent = `${done} / ${total}곡 인코딩 중`;
      });
      const json = JSON.stringify(backup);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `vinyl-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('백업 파일을 만들었어요');
    } catch (err) {
      console.error('[backup] 실패:', err);
      toast('백업 생성 중 오류가 발생했어요', { error: true });
    } finally {
      hideModal('progress-modal');
    }
  });

  byId('btn-restore').addEventListener('click', () => byId('restore-input').click());
  byId('restore-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    byId('progress-modal-title').textContent = '복원하는 중…';
    byId('progress-fill').style.width = '0%';
    byId('progress-modal-desc').textContent = '';
    showModal('progress-modal');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = await storage.restoreBackup(json, (done, total) => {
        byId('progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
        byId('progress-modal-desc').textContent = `${done} / ${total}곡 복원 중`;
      });
      await reloadLibrary();
      renderAll();
      toast(`${result.restoredSongs}곡을 복원했어요`);
    } catch (err) {
      console.error('[restore] 실패:', err);
      toast('백업 파일을 읽지 못했어요. 형식을 확인해주세요.', { error: true, duration: 4000 });
    } finally {
      hideModal('progress-modal');
    }
  });

  byId('btn-delete-all').addEventListener('click', async () => {
    if (state.songs.size === 0) { toast('삭제할 음악이 없어요'); return; }
    const ok = await confirmDialog('모든 음악 삭제', '저장된 모든 음악과 재생목록 정보가 삭제됩니다. 이 작업은 되돌릴 수 없습니다.', '전체 삭제');
    if (!ok) return;
    await storage.deleteAllSongs();
    await reloadLibrary();
    renderAll();
    toast('라이브러리를 초기화했어요');
  });

  byId('btn-install-help').addEventListener('click', () => {
    showInstallBanner(true);
  });

  // ---------------------------------------------------------------
  // 미니 플레이어 / 전체 플레이어
  // ---------------------------------------------------------------
  const miniPlayer = byId('mini-player');
  const fullPlayer = byId('full-player');

  function updateMiniPlayer(song) {
    if (!song) { miniPlayer.hidden = true; return; }
    miniPlayer.hidden = false;
    byId('mini-art').src = getArtUrl(song);
    byId('mini-title').textContent = song.title;
    byId('mini-artist').textContent = song.artist;
  }

  function updateFullPlayerMeta(song) {
    if (!song) return;
    byId('fp-title').textContent = song.title;
    byId('fp-artist').textContent = song.artist;
    byId('fp-art-img').src = getArtUrl(song);
    byId('record-label-img').src = getArtUrl(song);
    byId('fp-favorite').classList.toggle('active', !!song.favorite);
    setupLyricsForCurrentSong();
    applyAmbientGlow(song);
  }

  // 앨범아트 기반 미세한 ambient glow (평균 색상 추출)
  function applyAmbientGlow(song) {
    const url = getArtUrl(song);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        const color = `rgba(${r},${g},${b},0.16)`;
        document.documentElement.style.setProperty('--fp-glow-color', color);
      } catch {
        document.documentElement.style.setProperty('--fp-glow-color', 'rgba(255,156,115,0.12)');
      }
    };
    img.onerror = () => document.documentElement.style.setProperty('--fp-glow-color', 'rgba(255,156,115,0.12)');
    img.src = url;
  }

  function openFullPlayer() {
    fullPlayer.classList.add('open');
    fullPlayer.setAttribute('aria-hidden', 'false');
  }
  function closeFullPlayer() {
    fullPlayer.classList.remove('open');
    fullPlayer.setAttribute('aria-hidden', 'true');
  }
  miniPlayer.addEventListener('click', (e) => {
    if (e.target.closest('.mini-btn')) return;
    openFullPlayer();
  });
  miniPlayer.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.mini-btn')) {
      e.preventDefault();
      openFullPlayer();
    }
  });
  byId('fp-collapse').addEventListener('click', closeFullPlayer);
  byId('full-player-scrim').addEventListener('click', closeFullPlayer);

  // 미니 플레이어 위로 스와이프 -> 전체 플레이어 열기
  (function setupMiniSwipe() {
    let startY = null;
    miniPlayer.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
    miniPlayer.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy < -30) { openFullPlayer(); startY = null; }
    }, { passive: true });
  })();

  // 전체 플레이어 아래로 스와이프 -> 닫기
  (function setupSheetSwipe() {
    const sheet = byId('full-player-sheet');
    let startY = null, currentY = 0, dragging = false;
    const handleZone = byId('sheet-handle');
    function onStart(e) {
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      dragging = true;
      sheet.style.transition = 'none';
    }
    function onMove(e) {
      if (!dragging) return;
      const y = (e.touches ? e.touches[0].clientY : e.clientY);
      currentY = Math.max(0, y - startY);
      sheet.style.transform = `translateY(${currentY}px)`;
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (currentY > 120) closeFullPlayer();
      currentY = 0;
    }
    handleZone.addEventListener('touchstart', onStart, { passive: true });
    handleZone.addEventListener('touchmove', onMove, { passive: true });
    handleZone.addEventListener('touchend', onEnd);
    byId('fp-header').addEventListener('touchstart', onStart, { passive: true });
    byId('fp-header').addEventListener('touchmove', onMove, { passive: true });
    byId('fp-header').addEventListener('touchend', onEnd);
  })();

  // ---- 재생 컨트롤 버튼들 ----
  byId('mini-playpause').addEventListener('click', (e) => { e.stopPropagation(); player.togglePlay(); });
  byId('mini-prev').addEventListener('click', (e) => { e.stopPropagation(); player.previous(); });
  byId('fp-playpause').addEventListener('click', () => player.togglePlay());
  byId('fp-prev').addEventListener('click', () => player.previous());
  byId('fp-next').addEventListener('click', () => player.next());
  byId('fp-shuffle').addEventListener('click', () => {
    player.toggleShuffle();
    byId('fp-shuffle').classList.toggle('active', player.shuffle);
    toast(player.shuffle ? '셔플 켜짐' : '셔플 꺼짐');
  });
  byId('fp-repeat').addEventListener('click', () => {
    player.cycleRepeat();
    updateRepeatButton();
  });
  function updateRepeatButton() {
    const btn = byId('fp-repeat');
    btn.classList.toggle('active', player.repeat !== window.REPEAT_OFF);
    byId('repeat-one-dot').hidden = player.repeat !== window.REPEAT_ONE;
  }
  byId('fp-favorite').addEventListener('click', async () => {
    if (!player.currentSong) return;
    const song = player.currentSong;
    const fav = await ensureFavoritesPlaylist();
    const newFav = !song.favorite;
    await storage.updateSong(song.id, { favorite: newFav });
    song.favorite = newFav;
    if (newFav && !fav.songIds.includes(song.id)) fav.songIds.push(song.id); else fav.songIds = fav.songIds.filter((id) => id !== song.id);
    await storage.savePlaylist(fav);
    byId('fp-favorite').classList.toggle('active', newFav);
    await reloadLibrary();
  });

  // ---- 진행바 ----
  const fpSeek = byId('fp-seek');
  let seeking = false;
  fpSeek.addEventListener('input', () => {
    seeking = true;
    fpSeek.style.setProperty('--fill', `${fpSeek.value}%`);
    byId('fp-time-current').textContent = formatDuration((fpSeek.value / 100) * (player.audio.duration || 0));
  });
  fpSeek.addEventListener('change', () => {
    const t = (fpSeek.value / 100) * (player.audio.duration || 0);
    player.seek(t);
    seeking = false;
  });

  // ---- 볼륨 ----
  byId('fp-volume').addEventListener('input', (e) => player.setVolume(parseFloat(e.target.value)));

  // ---- LP / 가사 모드 토글 ----
  function setFpMode(mode) {
    state.fpMode = mode;
    byId('fp-art-mode').hidden = mode !== 'art';
    byId('fp-lp-mode').hidden = mode !== 'lp';
    byId('fp-lyrics-mode').hidden = mode !== 'lyrics';
    byId('fp-lp-toggle').classList.toggle('active', mode === 'lp');
    byId('fp-lyrics-toggle').classList.toggle('active', mode === 'lyrics');
  }
  byId('fp-lp-toggle').addEventListener('click', () => setFpMode(state.fpMode === 'lp' ? 'art' : 'lp'));
  byId('fp-lyrics-toggle').addEventListener('click', () => setFpMode(state.fpMode === 'lyrics' ? 'art' : 'lyrics'));

  function setupLyricsForCurrentSong() {
    const song = player.currentSong;
    const linesEl = byId('lyrics-lines');
    const emptyEl = byId('lyrics-empty');
    linesEl.innerHTML = '';
    state.lrcEntries = null;
    state.activeLyricLine = -1;

    if (!song || !song.lyrics) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    const lrc = window.LyricsEngine.parseLRC(song.lyrics);
    if (lrc) {
      state.lrcEntries = lrc;
      for (const entry of lrc) {
        const div = document.createElement('div');
        div.className = 'lyrics-line';
        div.textContent = entry.text;
        linesEl.appendChild(div);
      }
    } else {
      const div = document.createElement('div');
      div.className = 'lyrics-plain';
      div.textContent = song.lyrics;
      linesEl.appendChild(div);
    }
  }

  function updateLyricsSync(currentTime) {
    if (!state.lrcEntries) return;
    const idx = window.LyricsEngine.findActiveLineIndex(state.lrcEntries, currentTime);
    if (idx === state.activeLyricLine) return;
    state.activeLyricLine = idx;
    const lines = byId('lyrics-lines').children;
    for (let i = 0; i < lines.length; i++) lines[i].classList.toggle('active', i === idx);
    if (idx >= 0 && lines[idx]) {
      const container = byId('lyrics-scroll');
      const lineEl = lines[idx];
      const targetTop = lineEl.offsetTop - container.clientHeight / 2 + lineEl.clientHeight / 2;
      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------
  // 플레이어 이벤트 구독
  // ---------------------------------------------------------------
  function bindPlayerEvents() {
    player.addEventListener('trackchange', (e) => {
      const song = e.detail.song;
      updateMiniPlayer(song);
      updateFullPlayerMeta(song);
      updateRepeatButton();
      byId('fp-shuffle').classList.toggle('active', player.shuffle);
      renderAll(); // playing 표시 갱신
    });
    player.addEventListener('playstate', (e) => {
      const playing = e.detail.playing;
      byId('mini-play-icon').innerHTML = playing
        ? '<path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
        : '<path fill="currentColor" d="M8 5v14l11-7z"/>';
      byId('fp-play-icon').innerHTML = playing
        ? '<path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
        : '<path fill="currentColor" d="M8 5v14l11-7z"/>';
      byId('record')?.classList.toggle('spinning', playing);
      byId('tonearm')?.classList.toggle('playing', playing);
    });
    player.addEventListener('timeupdate', (e) => {
      const { currentTime, duration } = e.detail;
      const pct = duration ? (currentTime / duration) * 100 : 0;
      byId('mini-progress-fill').style.width = `${pct}%`;
      if (!seeking) {
        fpSeek.value = pct;
        fpSeek.style.setProperty('--fill', `${pct}%`);
        byId('fp-time-current').textContent = formatDuration(currentTime);
      }
      byId('fp-time-total').textContent = formatDuration(duration);
      updateLyricsSync(currentTime);
    });
    player.addEventListener('queuechange', () => renderQueueSheet());
    player.addEventListener('autoplay-blocked', () => {
      toast('재생 버튼을 눌러 재생을 시작해주세요');
    });
    player.addEventListener('error', (e) => {
      toast(e.detail.message || '재생 중 오류가 발생했어요', { error: true });
    });
    player.addEventListener('queue-ended', () => toast('재생목록이 끝났어요'));
  }

  // ---------------------------------------------------------------
  // 테마 (시스템 / 라이트 / 다크)
  // ---------------------------------------------------------------
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
      theme = 'system';
    }
    $$('#theme-tabs .segmented-item').forEach((b) => b.classList.toggle('active', b.dataset.themeOption === theme));
  }
  $$('#theme-tabs .segmented-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.themeOption;
      applyTheme(theme);
      await storage.setSetting('theme', theme);
    });
  });
  async function initTheme() {
    const saved = await storage.getSetting('theme', 'system');
    applyTheme(saved);
  }

  // ---------------------------------------------------------------
  // 설치 안내 배너
  // ---------------------------------------------------------------
  function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  }
  async function showInstallBanner(force = false) {
    if (isStandalone()) return;
    const seen = await storage.getSetting('installHintShown', false);
    if (seen && !force) return;
    byId('install-banner').hidden = false;
  }
  byId('install-banner-close').addEventListener('click', async () => {
    byId('install-banner').hidden = true;
    await storage.setSetting('installHintShown', true);
  });

  // ---------------------------------------------------------------
  // 전체 렌더 / 초기화
  // ---------------------------------------------------------------
  function renderAll() {
    renderHome();
    renderLibrary();
    renderSettings();
    if (searchInput.value.trim()) searchInput.dispatchEvent(new Event('input'));
  }

  async function init() {
    try {
      const info = await storage.init();
      console.log('[app] storage 초기화 완료. OPFS 사용 가능:', info.opfsAvailable);
    } catch (err) {
      console.error('[app] storage 초기화 실패:', err);
      toast('저장소를 초기화하지 못했습니다. 브라우저 설정을 확인해주세요.', { error: true, duration: 5000 });
    }

    await reloadLibrary();
    await ensureFavoritesPlaylist();
    await initTheme();

    player = new PlayerEngine(storage);
    window.__player = player;
    bindPlayerEvents();

    const restored = await player.restoreState();
    if (restored) {
      updateMiniPlayer(restored.song);
      updateFullPlayerMeta(restored.song);
      updateRepeatButton();
      byId('fp-shuffle').classList.toggle('active', player.shuffle);
      const dur = restored.song.duration || 0;
      const pct = dur ? (restored.position / dur) * 100 : 0;
      fpSeek.value = pct;
      byId('fp-time-current').textContent = formatDuration(restored.position);
      byId('fp-time-total').textContent = formatDuration(dur);
      byId('mini-progress-fill').style.width = `${pct}%`;
    }
    byId('fp-volume').value = player.audio.volume;

    renderAll();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.error('[app] Service Worker 등록 실패:', err);
      });
    }

    window.addEventListener('beforeunload', () => storage.revokeAllUrls());
  }

  document.addEventListener('DOMContentLoaded', init);
})();
