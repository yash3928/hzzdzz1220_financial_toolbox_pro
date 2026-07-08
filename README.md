# HZZDZZ Couple Finance v0.6.2 Sync Fix

## 덮어쓰기 파일
- index.html
- script.js
- style.css
- firebase.js

## 수정 핵심
- Firestore persistence 오류 제거
- Firebase 초기화 순서 안정화
- 공동 동기화 재연결 안정화
- 앱 재실행 후 저장된 Firebase 설정값/가계부 ID 자동 사용

## 확인 방법
1. 4개 파일을 GitHub에 덮어쓰기
2. iPhone Safari 캐시 새로고침 또는 홈화면 앱 재실행
3. 설정 > 공동 동기화에서 같은 Firebase 설정값과 hzzdzz_가계부 입력
4. 두 휴대폰에서 지출 1건 입력 후 서로 보이는지 확인
