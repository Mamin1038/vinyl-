# Vinyl — 개인용 오프라인 MP3 플레이어 (PWA)

iPhone Safari에서 홈 화면에 추가해 쓰는 개인용 음악 플레이어입니다.
MP3/M4A/AAC/WAV/FLAC 파일을 브라우저 안(OPFS 또는 IndexedDB)에 실제로 저장하고,
새로고침·앱 재실행·오프라인 상태에서도 그대로 재생됩니다.

## 1. 실행하려면 (중요)

Service Worker와 OPFS는 **HTTPS** 또는 **localhost**에서만 동작합니다.
`index.html`을 파일로 그냥 더블클릭해서 열면(`file://`) 정상 동작하지 않습니다.

### 로컬에서 테스트
```bash
cd mp3app
python3 -m http.server 8080
# 컴퓨터 브라우저에서 http://localhost:8080 접속
```

### iPhone에서 실제로 쓰려면
아무 정적 호스팅(GitHub Pages, Cloudflare Pages, Netlify, Vercel 등)에
`mp3app` 폴더 내용을 그대로 올리면 됩니다. HTTPS가 자동으로 적용됩니다.

배포 후 iPhone Safari로 접속 → 공유 버튼 → "홈 화면에 추가"를 누르면
앱처럼 아이콘이 생기고 standalone 모드로 실행됩니다.

## 2. 폴더 구조

```
index.html            앱 셸 (모든 화면 마크업)
style.css             Liquid Glass 스타일 + 반응형 + safe-area 대응
app.js                UI 로직, 뷰 라우팅, 렌더링
storage.js            OPFS/IndexedDB 저장 레이어, 백업/복원, 저장공간 조회
player.js             오디오 재생 엔진, 큐/셔플/반복, Media Session
metadata.js           ID3v2(MP3) / MPEG-4(M4A) 태그·앨범아트 파서
lyrics.js             일반 가사 + LRC 타임드 가사 파서/동기화
sw.js                 오프라인 앱 셸 캐싱용 서비스워커
manifest.webmanifest  PWA 매니페스트
assets/               앱 아이콘 (180/192/512 등)
```

## 3. 알아두면 좋은 점

- **저장 우선순위**: OPFS 지원 브라우저에서는 실제 파일로 저장하고, 지원하지
  않거나 쓰기가 막힌 환경에서는 자동으로 IndexedDB Blob 저장으로 전환합니다.
  설정 > 저장 방식에서 현재 어떤 방식으로 저장 중인지 확인할 수 있습니다.
- **영구 저장 요청**: 설정 화면에서 `navigator.storage.persist()`를 호출해
  브라우저가 임의로 데이터를 정리하지 않도록 요청합니다. 그래도 iOS Safari는
  네이티브 앱만큼의 보장은 하지 않으므로, 정기적으로 "라이브러리 백업"을
  이용해 주세요.
- **백업 형식**: 오디오 데이터를 base64로 포함한 단일 JSON 파일입니다. 곡이
  많으면 파일이 커지고 내보내기/복원에 시간이 걸릴 수 있습니다(진행률 표시됨).
- **가사**: MP3의 USLT 프레임을 자동으로 읽고, 없으면 곡별로 직접 붙여넣거나
  `.lrc` 파일을 연결할 수 있습니다. `[mm:ss.xx]` 형식이면 자동으로 타임드
  가사로 인식해 재생 위치에 맞춰 강조됩니다.
- **자동재생 제한**: iOS는 사용자 탭 없이는 오디오 재생을 막을 수 있어서,
  이런 경우 토스트로 "재생 버튼을 눌러주세요" 안내가 뜹니다. 정상입니다.

## 4. 테스트한 항목

가져오기 → 재생 → LP 모드 → 가사(LRC 동기화) → 검색 → 플레이리스트 →
즐겨찾기 → 설정(저장공간/저장방식) → 백업 → 전체 삭제 → 복원 →
새로고침 후 재생 상태 복원 → 오프라인 재실행까지 headless 브라우저로
직접 실행해 확인했습니다.
