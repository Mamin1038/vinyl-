/**
 * storage.js
 * -------------------------------------------------------------
 * 영구 저장소 레이어.
 *
 * 우선순위:
 *   1. OPFS (Origin Private File System) - 실제 파일로 오디오 blob 저장 시도
 *   2. IndexedDB - OPFS를 쓸 수 없거나 실패하면 blob을 직접 IndexedDB에 저장
 *
 * iOS Safari는 버전에 따라 OPFS의 createWritable 계열 API 지원이 제한적이므로
 * 항상 IndexedDB를 "정본(source of truth)"으로 두고, OPFS는 있으면 보너스로 사용한다.
 * (그래야 OPFS가 막혀도 절대 음악이 사라지지 않는다.)
 *
 * 메타데이터/플레이리스트/설정은 IndexedDB에 저장한다.
 * -------------------------------------------------------------
 */

const DB_NAME = 'mp3app-db';
const DB_VERSION = 1;
const STORE_SONGS = 'songs';       // { id, ...metadata, blob (IDB에 저장할 때만), opfsPath }
const STORE_PLAYLISTS = 'playlists';
const STORE_SETTINGS = 'settings';

class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

class Storage {
  constructor() {
    this.db = null;
    this.opfsRoot = null;
    this.opfsAvailable = false;
    this._objectUrls = new Map(); // songId -> object URL (재생용, revoke 관리)
  }

  async init() {
    this.db = await this._openDB();
    try {
      if ('storage' in navigator && navigator.storage.getDirectory) {
        this.opfsRoot = await navigator.storage.getDirectory();
        // 실제 쓰기가 가능한지 짧게 테스트 (iOS Safari는 API는 있어도 쓰기가 막힌 버전이 있음)
        const testHandle = await this.opfsRoot.getFileHandle('.write-test', { create: true });
        if (testHandle.createWritable) {
          const writable = await testHandle.createWritable();
          await writable.write(new Blob(['ok']));
          await writable.close();
          this.opfsAvailable = true;
        }
        await this.opfsRoot.removeEntry('.write-test').catch(() => {});
      }
    } catch (err) {
      console.error('[storage] OPFS unavailable, falling back to IndexedDB blob storage:', err);
      this.opfsAvailable = false;
    }
    return { opfsAvailable: this.opfsAvailable };
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_SONGS)) {
          const songStore = db.createObjectStore(STORE_SONGS, { keyPath: 'id' });
          songStore.createIndex('addedAt', 'addedAt');
          songStore.createIndex('album', 'album');
          songStore.createIndex('artist', 'artist');
        }
        if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
          db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new StorageError('IndexedDB를 열 수 없습니다.', req.error));
    });
  }

  _tx(storeName, mode = 'readonly') {
    return this.db.transaction(storeName, mode).objectStore(storeName);
  }

  // ---------------------------------------------------------------
  // Persistent storage 권한 요청
  // ---------------------------------------------------------------
  async requestPersistence() {
    if (!('storage' in navigator) || !navigator.storage.persist) {
      return { supported: false, persisted: false };
    }
    try {
      const already = await navigator.storage.persisted();
      if (already) return { supported: true, persisted: true };
      const granted = await navigator.storage.persist();
      return { supported: true, persisted: granted };
    } catch {
      return { supported: true, persisted: false };
    }
  }

  async getStorageEstimate() {
    if (!('storage' in navigator) || !navigator.storage.estimate) {
      return { usage: 0, quota: 0, supported: false };
    }
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0, supported: true };
    } catch {
      return { usage: 0, quota: 0, supported: false };
    }
  }

  // ---------------------------------------------------------------
  // 곡 저장 / 불러오기
  // ---------------------------------------------------------------

  /**
   * 곡을 저장한다. metadata는 blob을 포함하지 않은 순수 정보.
   * audioBlob은 실제 오디오 파일 데이터.
   */
  async addSong(metadata, audioBlob) {
    const id = metadata.id;
    let opfsPath = null;

    if (this.opfsAvailable) {
      try {
        opfsPath = `song-${id}`;
        const fileHandle = await this.opfsRoot.getFileHandle(opfsPath, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(audioBlob);
        await writable.close();
      } catch (err) {
        console.error('[storage] OPFS write failed, falling back to IndexedDB for this file:', err);
        opfsPath = null;
      }
    }

    const record = { ...metadata, opfsPath };
    if (!opfsPath) {
      // OPFS 실패 시 blob 자체를 IndexedDB에 저장 (IndexedDB는 Blob을 직접 지원)
      record.blob = audioBlob;
    }

    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SONGS, 'readwrite');
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => {
        if (req.error && req.error.name === 'QuotaExceededError') {
          reject(new StorageError('저장 공간이 부족합니다. 일부 음악을 삭제한 뒤 다시 시도해주세요.', req.error));
        } else {
          reject(new StorageError('음악을 저장하지 못했습니다.', req.error));
        }
      };
    });
  }

  async getAllSongs() {
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SONGS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new StorageError('음악 목록을 불러오지 못했습니다.', req.error));
    });
  }

  async getSong(id) {
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SONGS);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new StorageError('곡 정보를 불러오지 못했습니다.', req.error));
    });
  }

  async updateSong(id, patch) {
    const existing = await this.getSong(id);
    if (!existing) throw new StorageError('곡을 찾을 수 없습니다.');
    const updated = { ...existing, ...patch };
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SONGS, 'readwrite');
      const req = store.put(updated);
      req.onsuccess = () => resolve(updated);
      req.onerror = () => reject(new StorageError('곡 정보를 업데이트하지 못했습니다.', req.error));
    });
  }

  /**
   * 재생 가능한 object URL을 반환한다. (캐시하여 중복 생성 방지)
   */
  async getPlayableUrl(id) {
    if (this._objectUrls.has(id)) return this._objectUrls.get(id);
    const song = await this.getSong(id);
    if (!song) throw new StorageError('곡을 찾을 수 없습니다.');

    let blob;
    if (song.opfsPath && this.opfsAvailable) {
      try {
        const fileHandle = await this.opfsRoot.getFileHandle(song.opfsPath);
        blob = await fileHandle.getFile();
      } catch (err) {
        throw new StorageError('OPFS에서 오디오 파일을 읽지 못했습니다.', err);
      }
    } else if (song.blob) {
      blob = song.blob;
    } else {
      throw new StorageError('오디오 데이터를 찾을 수 없습니다.');
    }

    const url = URL.createObjectURL(blob);
    this._objectUrls.set(id, url);
    return url;
  }

  revokePlayableUrl(id) {
    const url = this._objectUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this._objectUrls.delete(id);
    }
  }

  revokeAllUrls() {
    for (const url of this._objectUrls.values()) URL.revokeObjectURL(url);
    this._objectUrls.clear();
  }

  async deleteSong(id) {
    const song = await this.getSong(id);
    this.revokePlayableUrl(id);
    if (song && song.opfsPath && this.opfsAvailable) {
      try {
        await this.opfsRoot.removeEntry(song.opfsPath);
      } catch (err) {
        console.error('[storage] OPFS 파일 삭제 실패:', err);
      }
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SONGS, 'readwrite');
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(new StorageError('곡을 삭제하지 못했습니다.', req.error));
    });
  }

  async deleteAllSongs() {
    const songs = await this.getAllSongs();
    for (const s of songs) {
      this.revokePlayableUrl(s.id);
      if (s.opfsPath && this.opfsAvailable) {
        await this.opfsRoot.removeEntry(s.opfsPath).catch(() => {});
      }
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SONGS, 'readwrite');
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(new StorageError('라이브러리를 초기화하지 못했습니다.', req.error));
    });
  }

  // ---------------------------------------------------------------
  // 플레이리스트
  // ---------------------------------------------------------------
  async getAllPlaylists() {
    return new Promise((resolve, reject) => {
      const req = this._tx(STORE_PLAYLISTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new StorageError('플레이리스트를 불러오지 못했습니다.', req.error));
    });
  }

  async savePlaylist(playlist) {
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_PLAYLISTS, 'readwrite');
      const req = store.put(playlist);
      req.onsuccess = () => resolve(playlist);
      req.onerror = () => reject(new StorageError('플레이리스트를 저장하지 못했습니다.', req.error));
    });
  }

  async deletePlaylist(id) {
    return new Promise((resolve, reject) => {
      const req = this._tx(STORE_PLAYLISTS, 'readwrite').delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(new StorageError('플레이리스트를 삭제하지 못했습니다.', req.error));
    });
  }

  // ---------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------
  async getSetting(key, fallback = null) {
    return new Promise((resolve, reject) => {
      const req = this._tx(STORE_SETTINGS).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => reject(new StorageError('설정을 불러오지 못했습니다.', req.error));
    });
  }

  async setSetting(key, value) {
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS, 'readwrite');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(new StorageError('설정을 저장하지 못했습니다.', req.error));
    });
  }

  // ---------------------------------------------------------------
  // 백업 / 복원
  // ---------------------------------------------------------------
  /**
   * 전체 라이브러리를 하나의 JSON 백업 파일로 내보낸다.
   * 오디오 blob은 base64로 인코딩하여 포함한다 (단일 파일 백업을 위해).
   * 파일이 매우 크면 시간이 걸릴 수 있음을 UI에서 안내한다.
   */
  async exportBackup(onProgress) {
    const songs = await this.getAllSongs();
    const playlists = await this.getAllPlaylists();
    const out = { version: 1, exportedAt: Date.now(), songs: [], playlists };

    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      let blob;
      if (s.opfsPath && this.opfsAvailable) {
        const fh = await this.opfsRoot.getFileHandle(s.opfsPath);
        blob = await fh.getFile();
      } else {
        blob = s.blob;
      }
      const base64 = await blobToBase64(blob);
      const { blob: _b, opfsPath: _o, ...meta } = s;
      out.songs.push({ ...meta, audioBase64: base64, audioMime: blob.type || s.mimeType });
      if (onProgress) onProgress(i + 1, songs.length);
    }
    return out;
  }

  async restoreBackup(backupJson, onProgress) {
    if (!backupJson || !Array.isArray(backupJson.songs)) {
      throw new StorageError('백업 파일 형식이 올바르지 않습니다.');
    }
    let done = 0;
    for (const s of backupJson.songs) {
      const { audioBase64, audioMime, ...meta } = s;
      const blob = base64ToBlob(audioBase64, audioMime || meta.mimeType || 'audio/mpeg');
      await this.addSong(meta, blob);
      done++;
      if (onProgress) onProgress(done, backupJson.songs.length);
    }
    if (Array.isArray(backupJson.playlists)) {
      for (const p of backupJson.playlists) {
        await this.savePlaylist(p);
      }
    }
    return { restoredSongs: done, restoredPlaylists: (backupJson.playlists || []).length };
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result; // data:mime;base64,XXXX
      const idx = result.indexOf(',');
      resolve(result.slice(idx + 1));
    };
    reader.onerror = () => reject(new StorageError('파일 인코딩 중 오류가 발생했습니다.', reader.error));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mime) {
  const byteChars = atob(base64);
  const byteArrays = [];
  const sliceSize = 1024 * 1024;
  for (let offset = 0; offset < byteChars.length; offset += sliceSize) {
    const slice = byteChars.slice(offset, offset + sliceSize);
    const bytes = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i);
    byteArrays.push(new Uint8Array(bytes));
  }
  return new Blob(byteArrays, { type: mime });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  const decimals = val >= 100 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(decimals)} ${units[i]}`;
}

window.AppStorage = new Storage();
window.StorageError = StorageError;
window.formatBytes = formatBytes;
