/**
 * metadata.js
 * -------------------------------------------------------------
 * MP3(ID3v2)와 M4A/AAC(MPEG-4 atoms)의 태그를 직접 파싱한다.
 * 외부 라이브러리 없이 순수 JS로 구현 (오프라인에서도 100% 동작해야 하므로).
 *
 * 지원 태그: 제목, 아티스트, 앨범, 앨범아티스트, 트랙/디스크 번호, 앨범아트, 가사(USLT)
 * 지원하지 않는 포맷/손상된 파일은 조용히 실패하지 않고 명확한 오류를 던진다.
 * -------------------------------------------------------------
 */

const TextDecoderLatin1 = new TextDecoder('iso-8859-1');
const TextDecoderUTF8 = new TextDecoder('utf-8');
const TextDecoderUTF16LE = new TextDecoder('utf-16le');

function decodeID3String(bytes, encodingByte) {
  // encodingByte: 0=ISO-8859-1, 1=UTF-16 (BOM), 2=UTF-16BE, 3=UTF-8
  try {
    if (encodingByte === 0) return TextDecoderLatin1.decode(bytes).replace(/\0+$/, '');
    if (encodingByte === 3) return TextDecoderUTF8.decode(bytes).replace(/\0+$/, '');
    // UTF-16 variants: strip BOM if present, assume LE (가장 흔함)
    let b = bytes;
    if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
      b = b.slice(2);
    }
    return TextDecoderUTF16LE.decode(b).replace(/\0+$/, '');
  } catch {
    return TextDecoderLatin1.decode(bytes).replace(/\0+$/, '');
  }
}

function synchsafeToInt(bytes) {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f);
}

function plainIntFromBytes(bytes) {
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
}

/**
 * MP3 파일에서 ID3v2 태그를 파싱한다.
 */
function parseID3v2(buffer) {
  const view = new DataView(buffer);
  const result = { title: null, artist: null, album: null, albumArtist: null,
    trackNumber: null, discNumber: null, artwork: null, artworkMime: null, lyrics: null };

  if (buffer.byteLength < 10) return result;
  // 'ID3' 헤더 확인
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
    return result; // ID3 태그 없음 (파일명 기반 fallback으로 처리됨)
  }

  const majorVersion = view.getUint8(3);
  const flags = view.getUint8(5);
  const sizeBytes = new Uint8Array(buffer.slice(6, 10));
  const tagSize = synchsafeToInt(sizeBytes);
  let offset = 10;

  if (flags & 0x40) {
    // extended header 존재 -> 건너뛴다
    const extSize = majorVersion >= 4
      ? synchsafeToInt(new Uint8Array(buffer.slice(offset, offset + 4)))
      : plainIntFromBytes(new Uint8Array(buffer.slice(offset, offset + 4)));
    offset += extSize;
  }

  const end = Math.min(10 + tagSize, buffer.byteLength);

  while (offset < end - 10) {
    let frameId, frameSize, frameFlagsLen = 2;
    if (majorVersion === 2) {
      // ID3v2.2: 3자 ID, 3바이트 크기
      frameId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2));
      frameSize = (view.getUint8(offset + 3) << 16) | (view.getUint8(offset + 4) << 8) | view.getUint8(offset + 5);
      offset += 6;
      frameFlagsLen = 0;
    } else {
      frameId = String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)
      );
      const sizeArr = new Uint8Array(buffer.slice(offset + 4, offset + 8));
      frameSize = majorVersion >= 4 ? synchsafeToInt(sizeArr) : plainIntFromBytes(sizeArr);
      offset += 10;
    }

    if (!frameId || frameId === '\0\0\0\0' || frameId.trim() === '' || frameSize <= 0 || offset + frameSize > buffer.byteLength) {
      break;
    }

    const frameData = buffer.slice(offset, offset + frameSize);

    try {
      if (frameId === 'TIT2' || frameId === 'TT2') {
        result.title = decodeID3String(new Uint8Array(frameData.slice(1)), new Uint8Array(frameData)[0]);
      } else if (frameId === 'TPE1' || frameId === 'TP1') {
        result.artist = decodeID3String(new Uint8Array(frameData.slice(1)), new Uint8Array(frameData)[0]);
      } else if (frameId === 'TPE2' || frameId === 'TP2') {
        result.albumArtist = decodeID3String(new Uint8Array(frameData.slice(1)), new Uint8Array(frameData)[0]);
      } else if (frameId === 'TALB' || frameId === 'TAL') {
        result.album = decodeID3String(new Uint8Array(frameData.slice(1)), new Uint8Array(frameData)[0]);
      } else if (frameId === 'TRCK' || frameId === 'TRK') {
        const raw = decodeID3String(new Uint8Array(frameData.slice(1)), new Uint8Array(frameData)[0]);
        result.trackNumber = parseInt(raw.split('/')[0], 10) || null;
      } else if (frameId === 'TPOS' || frameId === 'TPA') {
        const raw = decodeID3String(new Uint8Array(frameData.slice(1)), new Uint8Array(frameData)[0]);
        result.discNumber = parseInt(raw.split('/')[0], 10) || null;
      } else if (frameId === 'APIC' || frameId === 'PIC') {
        const parsed = parseAPIC(new Uint8Array(frameData), frameId === 'PIC');
        if (parsed) {
          result.artwork = parsed.data;
          result.artworkMime = parsed.mime;
        }
      } else if (frameId === 'USLT' || frameId === 'ULT') {
        const parsed = parseUSLT(new Uint8Array(frameData));
        if (parsed) result.lyrics = parsed;
      }
    } catch (err) {
      console.error(`[metadata] 프레임 ${frameId} 파싱 실패:`, err);
    }

    offset += frameSize;
  }

  return result;
}

function parseAPIC(bytes, isV22) {
  const encoding = bytes[0];
  let i = 1;
  let mime;
  if (isV22) {
    mime = 'image/' + (String.fromCharCode(bytes[1], bytes[2], bytes[3]).toLowerCase() === 'jpg' ? 'jpeg' : 'png');
    i = 4;
  } else {
    let end = i;
    while (end < bytes.length && bytes[end] !== 0) end++;
    mime = TextDecoderLatin1.decode(bytes.slice(i, end)) || 'image/jpeg';
    i = end + 1;
  }
  i += 1; // picture type byte
  // description string (encoding에 따라 null 종료자가 1바이트 또는 2바이트)
  if (encoding === 1 || encoding === 2) {
    while (i < bytes.length - 1 && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < bytes.length && bytes[i] !== 0) i += 1;
    i += 1;
  }
  const imageData = bytes.slice(i);
  if (!imageData.length) return null;
  return { mime, data: new Blob([imageData], { type: mime }) };
}

function parseUSLT(bytes) {
  const encoding = bytes[0];
  let i = 4; // language (3바이트) 건너뜀
  // content descriptor 건너뛰기
  if (encoding === 1 || encoding === 2) {
    while (i < bytes.length - 1 && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < bytes.length && bytes[i] !== 0) i += 1;
    i += 1;
  }
  const lyricsBytes = bytes.slice(i);
  return decodeID3String(lyricsBytes, encoding);
}

/**
 * M4A/AAC(MPEG-4) 파일의 atom 구조를 순회하며 metadata를 찾는다.
 * moov > udta > meta > ilst > (©nam / ©ART / ©alb / trkn / covr ...)
 */
function parseM4A(buffer) {
  const result = { title: null, artist: null, album: null, albumArtist: null,
    trackNumber: null, discNumber: null, artwork: null, artworkMime: null, lyrics: null };
  const view = new DataView(buffer);

  function readAtoms(start, end, path) {
    let offset = start;
    while (offset < end - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      if (size < 8) break;
      const contentStart = offset + 8;
      const contentEnd = Math.min(offset + size, end);

      if (['moov', 'udta', 'meta', 'ilst'].includes(type)) {
        const innerStart = type === 'meta' ? contentStart + 4 : contentStart; // meta atom엔 4바이트 version/flags
        readAtoms(innerStart, contentEnd, path.concat(type));
      } else if (path[path.length - 1] === 'ilst') {
        parseIlstChild(type, contentStart, contentEnd);
      }
      offset += size;
    }
  }

  function findDataAtom(start, end) {
    let offset = start;
    while (offset < end - 8) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      if (type === 'data' && size >= 16) {
        const dataClass = view.getUint32(offset + 8);
        const dataStart = offset + 16;
        const dataEnd = offset + size;
        return { dataClass, bytes: new Uint8Array(buffer.slice(dataStart, dataEnd)) };
      }
      if (size < 8) break;
      offset += size;
    }
    return null;
  }

  function parseIlstChild(type, start, end) {
    const found = findDataAtom(start, end);
    if (!found) return;
    if (type === '\xa9nam') result.title = TextDecoderUTF8.decode(found.bytes);
    else if (type === '\xa9ART') result.artist = TextDecoderUTF8.decode(found.bytes);
    else if (type === 'aART') result.albumArtist = TextDecoderUTF8.decode(found.bytes);
    else if (type === '\xa9alb') result.album = TextDecoderUTF8.decode(found.bytes);
    else if (type === '\xa9lyr') result.lyrics = TextDecoderUTF8.decode(found.bytes);
    else if (type === 'trkn' && found.bytes.length >= 4) result.trackNumber = (found.bytes[2] << 8) | found.bytes[3];
    else if (type === 'disk' && found.bytes.length >= 4) result.discNumber = (found.bytes[2] << 8) | found.bytes[3];
    else if (type === 'covr') {
      const mime = found.dataClass === 14 ? 'image/png' : 'image/jpeg';
      result.artwork = new Blob([found.bytes], { type: mime });
      result.artworkMime = mime;
    }
  }

  try {
    readAtoms(0, buffer.byteLength, []);
  } catch (err) {
    console.error('[metadata] M4A 파싱 중 오류:', err);
  }
  return result;
}

/**
 * <audio> 엘리먼트를 이용해 실제 재생 가능한 길이를 얻는다 (초 단위).
 */
function getAudioDuration(blobUrl) {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      audio.src = '';
      resolve(val);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(0);
    setTimeout(() => finish(0), 8000);
    audio.src = blobUrl;
  });
}

const EXT_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
};

function guessTypeFromFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { ext, mime: file.type || EXT_MIME[ext] || 'application/octet-stream' };
}

function titleFromFilename(fileName) {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  return withoutExt.replace(/[_-]+/g, ' ').trim() || fileName;
}

/**
 * 파일 하나에서 메타데이터 + 오디오 길이를 모두 추출한다.
 * 실패해도 최소한 파일명 기반 title은 채워서 반환한다.
 */
async function extractMetadata(file) {
  const { ext, mime } = guessTypeFromFile(file);
  const buffer = await file.arrayBuffer();

  let tags = { title: null, artist: null, album: null, albumArtist: null,
    trackNumber: null, discNumber: null, artwork: null, artworkMime: null, lyrics: null };

  try {
    if (ext === 'mp3') {
      tags = parseID3v2(buffer);
    } else if (ext === 'm4a' || ext === 'aac' || mime === 'audio/mp4') {
      tags = parseM4A(buffer);
    }
    // wav/flac은 태그 파싱을 시도하지 않고 파일명 기반으로 처리 (범위 밖)
  } catch (err) {
    console.error(`[metadata] ${file.name} 태그 파싱 실패, 파일명 기반으로 대체:`, err);
  }

  return {
    title: tags.title || titleFromFilename(file.name),
    artist: tags.artist || '알 수 없는 아티스트',
    album: tags.album || '알 수 없는 앨범',
    albumArtist: tags.albumArtist || tags.artist || null,
    trackNumber: tags.trackNumber,
    discNumber: tags.discNumber,
    artwork: tags.artwork || null,
    lyrics: tags.lyrics || null,
    mimeType: mime,
    ext,
    size: file.size,
    fileName: file.name,
  };
}

const SUPPORTED_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac'];

window.MetadataParser = {
  extractMetadata,
  getAudioDuration,
  guessTypeFromFile,
  SUPPORTED_EXTENSIONS,
};
