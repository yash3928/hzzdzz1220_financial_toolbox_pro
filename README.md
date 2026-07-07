# 부부 공동 가계부 v2

## 핵심 변경
- 하단 메뉴(홈/입력/분석/설정)가 실제 화면 전환되도록 수정
- 로컬 저장 유지
- Firebase Cloud Firestore 공동 동기화 추가
- 같은 Firebase 설정 + 같은 가계부 코드를 입력하면 두 사람이 같은 데이터를 실시간 공유

## Firebase 사용 순서
1. Firebase 콘솔에서 프로젝트 생성
2. 웹 앱 등록 후 firebaseConfig 값을 복사
3. Firestore Database 생성
4. 앱의 설정 화면에서 가계부 코드와 firebaseConfig JSON 붙여넣기
5. 배우자 휴대폰에서도 같은 설정값과 같은 가계부 코드 입력

## Firestore 데이터 경로
households/{가계부코드}/entries/{내역ID}

## 개발/테스트용 보안 규칙 예시
주의: 아래 규칙은 테스트용입니다. 실제 운영 전에는 로그인 기반 규칙으로 바꾸는 것이 안전합니다.

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /households/{householdId}/entries/{entryId} {
      allow read, write: if true;
    }
  }
}

## 다음 단계 권장
- Firebase Authentication 추가
- 진혁/다혜 계정만 접근 가능하도록 보안 규칙 강화
- 예산 설정 화면 추가
- 자산현황 화면 추가
- 월별 비교 분석 추가
