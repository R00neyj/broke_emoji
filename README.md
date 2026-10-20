# broke_emoji (거지티콘)

내 이미지를 카카오톡 이모티콘처럼 만들어 갤러리에 모아두고, 클릭 한 번으로 클립보드에 복사해 채팅방에 붙여넣는 Windows 앱입니다.

## 기능

- 이미지 추가: 파일 선택 / 드래그 앤 드롭 / 붙여넣기
- 자동 처리: 단색 배경(채팅방 스크린샷 배경 등) 제거, 여백 잘라내기, 긴 변 360px 제한, 투명 PNG로 저장
- 복사: 내 채팅방 배경색으로 칠한 불투명 이미지로 클립보드 복사 (기본 `#BACEE0`, 카카오톡 기본 15색 프리셋·스포이드 지원)
- 드래그 아웃: 셀을 창 밖으로 끌어 카카오톡 채팅방에 바로 드롭
- 탭(하위 폴더), 다중 선택, 자르기, 클릭해서 투명 처리(글자 안쪽 등), 항상 위, 라이트/다크 테마
- 포터블: 모든 데이터는 exe 옆 `거지티콘_data/`에 저장. 네트워크 통신 없음

## 다운로드

[Releases](https://github.com/R00neyj/broke_emoji/releases)에서 `broke_emoji-<버전>.exe`를 받아 실행하세요. 설치 과정은 없습니다 (Windows 10/11, WebView2 필요).

## 빌드

준비물: Rust (MSVC), Visual Studio Build Tools (C++ 워크로드), Node.js

```sh
npm install
npm run dev     # 개발 실행
npm run build   # src-tauri/target/release/거지티콘.exe
```

## 릴리즈

`v*` 태그를 푸시하면 GitHub Actions(`.github/workflows/release.yml`)가 Windows에서 `npm run build`를 실행하고 exe를 릴리즈에 첨부합니다.

```sh
git tag v0.1.0
git push origin v0.1.0
```

Actions 탭에서 수동 실행(workflow_dispatch)하면 릴리즈 없이 빌드 결과만 아티팩트로 받을 수 있습니다.
