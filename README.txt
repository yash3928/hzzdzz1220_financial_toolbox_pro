# Financial Toolbox Pro v5

## 구성 파일
- `Code.gs`: Google Apps Script에 붙여넣는 서버 코드
- `index.html`: GitHub Pages 저장소에 올리는 웹 화면

## 설치 순서
1. 구글시트 열기
2. 확장 프로그램 → Apps Script
3. 기본 코드를 모두 지우고 `Code.gs` 내용을 붙여넣기
4. 저장
5. 배포 → 새 배포 → 유형: 웹 앱
6. 실행 사용자: 나
7. 액세스 권한: 모든 사용자
8. 배포 후 생성된 Web app URL 복사
9. GitHub Pages 저장소에 `index.html` 업로드
10. 웹페이지에서 Apps Script 웹앱 URL 입력 후 불러오기

## 반영 내용
- `예산` 시트: 월별 수입, 고정비, 투자, 잉여
- `가계부` 시트: 월별 분류/내역/지출액/결제자
- `가계부잔액` 시트: 식비/생필품/비상금 잔액
- 투자/주식/ETF/코인/청약/적금/CMA/ISA/연금/배당 등은 투자 파트로 별도 분류

[v1.4.6 아이콘 경로 수정]
- 아이콘 파일은 저장소 루트에 있으므로 index.html과 manifest의 icons/ 경로를 루트 경로로 수정했습니다.
- iPhone에서는 기존 홈 화면 바로가기를 삭제한 후 Safari 페이지를 완전히 새로 열어 다시 홈 화면에 추가해야 합니다.


v1.4.7: 앱 아이콘 내부 문구와 홈 화면 표시 이름을 dzzhzz로 변경했습니다.
