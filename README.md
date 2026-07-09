# HZZDZZ Couple Finance v1.1.0

내부 구조 안정화 버전입니다.

업로드 파일/폴더:
- index.html
- script.js
- firebase.js
- style.css
- js/app.js
- js/firebase.js
- css/style.css

중요:
- Firebase 데이터 경로는 기존과 동일하게 유지합니다.
- 기존 데이터는 먼저 읽고, 일반 저장에서는 빈 값으로 덮어쓰지 않도록 보호합니다.
- 백업 복원(forceRestore)일 때만 백업 파일 기준으로 덮어씁니다.


## v1.1.6 수정사항
- 지출내역 삭제 후 새로고침 시 다시 나타나는 문제 수정
- Firebase 저장 시 빈 배열 삭제/초기화가 실제로 반영되도록 수정
- 금액 입력 및 표시 천 단위 콤마 유지
