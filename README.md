# HZZDZZ Couple Finance v0.6.1 Beta

공동 동기화 안정화 버전입니다.

## 이번 수정 핵심
- Firebase CDN 안정 버전으로 변경
- 앱을 껐다 켜도 Firebase 설정값/가계부 ID 자동 유지
- v2/v3 이전 동기화 설정 자동 인식
- v2 로컬 입력내역 자동 마이그레이션 보강
- 연결 지연/오류 상태 표시 보강
- 프로그램 업데이트와 Firebase 데이터 분리 유지

## 덮어쓰기 파일
- index.html
- script.js
- style.css
- firebase.js

## 확인 방법
1. 설정 > 공동 동기화에서 Firebase 설정값과 hzzdzz_가계부 입력 후 저장
2. 상태가 공동 동기화로 바뀌는지 확인
3. 두 휴대폰에서 같은 설정값과 같은 가계부 ID를 입력
4. 한쪽에서 테스트 지출 입력 후 다른 쪽에 표시되는지 확인
