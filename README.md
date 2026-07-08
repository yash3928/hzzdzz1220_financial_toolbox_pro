# HZZDZZ Couple Finance v0.8.3

## 핵심 수정
- 프로그램 업데이트 후 기존 Firebase 데이터가 빈 기본값으로 덮어써지는 문제 방지
- Firebase 기존 데이터를 먼저 읽기 전에는 저장 차단
- 투자/지출 배열 데이터 보존 안전장치 추가
- 기존 세후 급여 계산식 유지

## 덮어쓰기 파일
- index.html
- script.js
- style.css
- firebase.js

## 주의
이미 Firestore에 남아있는 데이터는 이 버전에서 다시 불러올 수 있습니다.
만약 화면에서만 안 보였던 경우, 업데이트 후 공동 동기화 연결/새로고침을 실행하면 복구됩니다.
