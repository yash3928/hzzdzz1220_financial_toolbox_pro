# HZZDZZ Couple Finance v1.3.0

## 정리된 구조
- `index.html`: 화면 구조
- `css/style.css`: 화면 스타일
- `app.js`: 앱 시작, 화면 렌더링, 이벤트 연결
- `config.js`: 고정 분류와 기본값
- `utils.js`: 금액·문자열 공통 함수
- `view-period.js`: 각 기기의 연도·월 선택
- `firebase.js`: 공동 Firebase 읽기·저장
- `style.css`: 화면 스타일

## 데이터 호환
- 기존 Firestore 경로 `households/{가계부 ID}` 유지
- 기존 localStorage 키 유지
- 기존 2026년 데이터 및 `yearData` 구조 유지
- 연도·월 화면 선택은 각 기기에만 저장

## GitHub 업로드
저장소 루트에 `index.html`, `README.md`, `css` 폴더, `js` 폴더를 그대로 업로드합니다.
기존 루트의 `app.js`, `firebase.js`, `style.css`는 새 버전이 정상 배포된 뒤 삭제할 수 있습니다.
