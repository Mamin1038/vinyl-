/**
 * player.js
 * -------------------------------------------------------------
 * HTMLAudioElement 기반 재생 엔진.
 * 큐 관리, shuffle/repeat, Media Session API, 상태 저장/복원을 담당한다.
 * UI는 이 클래스가 내보내는 이벤트('trackchange', 'playstate', 'timeupdate', 'queuechange')를 구독한다.
 * -------------------------------------------------------------
 */

const REPEAT_OFF = 'off';
const REPEAT_ALL = 'all';
const REPEAT_ONE = 'one';

class PlayerEngine extends EventTarget {
  constructor(storage) {
    super();
    this.storage = storage;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];          // song id 배열 (원래 순서)
    this.shuffledQueue = [];  // shuffle 켜졌을 때 사용되는 순서
    this.currentIndex = -1;
    this.shuffle = false;
    this.repeat = REPEAT_OFF;
    this.currentSong = null;
    this._saveTimer = null;
    this._pendingResume = null; // { songId, position } - 새로고침 후 복원 대기

    this.audio.addEventListener('ended', () => this._onEnded());
    this.audio.addEventListener('play', () => this._emitPlayState());
    this.audio.addEventListener('pause', () => this._emitPlayState());
    this.audio.addEventListener('timeupdate', () => {
      this._emit('timeupdate', { currentTime: this.audio.currentTime, duration: this.audio.duration || 0 });
      this._scheduleStateSave();
    });
    this.audio.addEventListener('error', () => {
      this._emit('error', { message: '오디오 재생 중 오류가 발생했습니다.', error: this.audio.error });
    });

    this._setupMediaSession();
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  _emitPlayState() {
    this._emit('playstate', { playing: !this.audio.paused });
  }

  get activeQueue() {
    return this.shuffle ? this.shuffledQueue : this.queue;
  }

  // ---------------------------------------------------------------
  // 큐 설정 및 재생
  // ---------------------------------------------------------------

  /**
   * songIds: 재생할 곡 id 배열, startIndex: 그 중 바로 재생할 인덱스
   */
  async playQueue(songIds, startIndex = 0) {
    this.queue = [...songIds];
    this.shuffledQueue = this.shuffle ? this._shuffleArray(songIds) : [...songIds];
    const startId = songIds[startIndex];
    this.currentIndex = this.activeQueue.indexOf(startId);
    this._emit('queuechange', { queue: this.queue });
    await this._loadAndPlay(startId);
  }

  async _loadAndPlay(songId) {
    try {
      const song = await this.storage.getSong(songId);
      if (!song) throw new StorageError('곡을 찾을 수 없습니다.');
      const url = await this.storage.getPlayableUrl(songId);
      this.currentSong = song;
      this.audio.src = url;
      this.audio.currentTime = 0;
      await this._tryPlay();
      this._emit('trackchange', { song });
      this._updateMediaSessionMetadata(song);
      this.storage.updateSong(songId, { lastPlayedAt: Date.now(), playCount: (song.playCount || 0) + 1 }).catch(() => {});
      this._scheduleStateSave(true);
    } catch (err) {
      console.error('[player] 재생 실패:', err);
      this._emit('error', { message: err.message || '재생할 수 없는 파일입니다.', error: err });
    }
  }

  async _tryPlay() {
    try {
      await this.audio.play();
    } catch (err) {
      // iOS 자동재생 정책: 사용자 제스처 없이는 재생이 거부될 수 있음.
      // UI에서 재생 버튼을 다시 눌러야 한다는 안내를 표시하도록 이벤트를 보낸다.
      this._emit('autoplay-blocked', {});
    }
  }

  async togglePlay() {
    if (!this.currentSong) return;
    if (this.audio.paused) await this._tryPlay();
    else this.audio.pause();
  }

  async playSongNow(songId, contextQueue) {
    if (contextQueue && contextQueue.length) {
      await this.playQueue(contextQueue, contextQueue.indexOf(songId));
    } else {
      await this.playQueue([songId], 0);
    }
  }

  async next(userInitiated = true) {
    if (this.activeQueue.length === 0) return;
    if (this.repeat === REPEAT_ONE && !userInitiated) {
      this.audio.currentTime = 0;
      await this._tryPlay();
      return;
    }
    let nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.activeQueue.length) {
      if (this.repeat === REPEAT_ALL) nextIndex = 0;
      else {
        this.audio.pause();
        this._emit('queue-ended', {});
        return;
      }
    }
    this.currentIndex = nextIndex;
    await this._loadAndPlay(this.activeQueue[this.currentIndex]);
  }

  async previous() {
    if (this.activeQueue.length === 0) return;
    // 3초 이상 재생됐으면 처음으로, 아니면 이전 곡으로 (일반적인 음악 앱 동작)
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    let prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      prevIndex = this.repeat === REPEAT_ALL ? this.activeQueue.length - 1 : 0;
    }
    this.currentIndex = prevIndex;
    await this._loadAndPlay(this.activeQueue[this.currentIndex]);
  }

  seek(seconds) {
    if (!isFinite(seconds)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration || seconds));
  }

  setVolume(v) {
    this.audio.volume = Math.max(0, Math.min(1, v));
    this.storage.setSetting('volume', this.audio.volume).catch(() => {});
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const currentId = this.currentSong ? this.currentSong.id : null;
    this.shuffledQueue = this.shuffle ? this._shuffleArray(this.queue) : [...this.queue];
    if (currentId) this.currentIndex = this.activeQueue.indexOf(currentId);
    this._emit('queuechange', { queue: this.queue });
    this.storage.setSetting('shuffle', this.shuffle).catch(() => {});
  }

  cycleRepeat() {
    this.repeat = this.repeat === REPEAT_OFF ? REPEAT_ALL : this.repeat === REPEAT_ALL ? REPEAT_ONE : REPEAT_OFF;
    this.storage.setSetting('repeat', this.repeat).catch(() => {});
    this._emit('repeatchange', { repeat: this.repeat });
  }

  _shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  _onEnded() {
    this.next(false);
  }

  // ---------------------------------------------------------------
  // 상태 저장 / 복원 (새로고침 대응)
  // ---------------------------------------------------------------
  _scheduleStateSave(immediate = false) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    const save = () => {
      if (!this.currentSong) return;
      this.storage.setSetting('playbackState', {
        songId: this.currentSong.id,
        position: this.audio.currentTime || 0,
        queue: this.queue,
        currentIndex: this.currentIndex,
        shuffle: this.shuffle,
        repeat: this.repeat,
      }).catch(() => {});
    };
    if (immediate) save();
    else this._saveTimer = setTimeout(save, 2000);
  }

  /**
   * 앱 시작 시 마지막 재생 상태를 불러온다 (자동 재생은 하지 않음, iOS 정책 때문).
   */
  async restoreState() {
    const state = await this.storage.getSetting('playbackState', null);
    const volume = await this.storage.getSetting('volume', 1);
    this.audio.volume = volume;
    if (!state || !state.songId) return null;

    const song = await this.storage.getSong(state.songId);
    if (!song) return null;

    this.queue = state.queue || [state.songId];
    this.shuffle = !!state.shuffle;
    this.repeat = state.repeat || REPEAT_OFF;
    this.shuffledQueue = this.shuffle ? this._shuffleArray(this.queue) : [...this.queue];
    this.currentIndex = this.activeQueue.indexOf(state.songId);
    this.currentSong = song;

    try {
      const url = await this.storage.getPlayableUrl(state.songId);
      this.audio.src = url;
      this.audio.currentTime = state.position || 0;
    } catch (err) {
      console.error('[player] 이전 재생 상태 복원 실패:', err);
      return null;
    }

    this._updateMediaSessionMetadata(song);
    this._emit('trackchange', { song, restored: true });
    return { song, position: state.position || 0 };
  }

  // ---------------------------------------------------------------
  // Media Session (iOS 잠금화면 / 제어센터)
  // ---------------------------------------------------------------
  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        this.seek(this.audio.currentTime - (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        this.seek(this.audio.currentTime + (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) this.seek(details.seekTime);
      });
    } catch (err) {
      console.error('[player] Media Session 액션 등록 중 일부 실패(지원 범위 밖일 수 있음):', err);
    }
  }

  async _updateMediaSessionMetadata(song) {
    if (!('mediaSession' in navigator)) return;
    let artwork = [];
    try {
      if (song.artwork) {
        const url = URL.createObjectURL(song.artwork);
        artwork = [{ src: url, sizes: '512x512', type: song.artwork.type || 'image/jpeg' }];
      }
    } catch {}
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: song.album,
        artwork,
      });
      navigator.mediaSession.playbackState = this.audio.paused ? 'paused' : 'playing';
    } catch (err) {
      console.error('[player] Media Session metadata 설정 실패:', err);
    }
  }
}

window.PlayerEngine = PlayerEngine;
window.REPEAT_OFF = REPEAT_OFF;
window.REPEAT_ALL = REPEAT_ALL;
window.REPEAT_ONE = REPEAT_ONE;
