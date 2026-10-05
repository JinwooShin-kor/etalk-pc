# 애톡 운영 콘솔

**여기가 원본이다.** 앱과 같은 저장소에 있지만 **앱에는 실리지 않는다.**

플러터는 `pubspec.yaml` 의 `assets:` 에 적힌 것만 앱 꾸러미에 싼다. 이 폴더는
거기 없으므로 `flutter build` 결과물에 들어가지 않는다 — 실제 빌드 산출물
(`flutter_assets`)에도 없다는 것을 확인했고, 나중에 누가 실수로 넣는 것을
`test/console_not_in_app_test.dart` 가 막는다.

| | |
|---|---|
| 사는 곳 | <https://etalk.kr/etalk-admin/> |
| 올리는 법 | `./tool/deploy_console.sh` (`--dry` 로 미리 보기) |
| 배포본 | 공개 저장소 `JinwooShin-kor/etalk-pc` 의 `etalk-admin/` |
| 로그인 | `admin@etalk.kr` · 비밀번호는 맥 키체인 `etalk-admin-console` |
| 서버 함수 | `ae_ops_*` — 기본 집계 0238 · 0239 · 0240, 매출 0242, 행동 기록 0246, 대화 원문 0247 · 0287 |

**배포본을 직접 고치지 마라.** 다음 배포에 덮인다.

## 파일

- `index.html` — 여덟 메뉴, 사이드바, 카드와 검색·쪽 이동 영역의 뼈대.
- `app.js` — 인증, 실시간 연결, 집계 조회와 화면 렌더링, 문의 답장과 설정 저장.
  문의·설정 초안과 저장 중 상태를 보존한다. 집계 숫자는 서버에서 받은 값을 쓴다.
- `messages.js` — 커플 행동 기록과 테스트 대화 조회, 최신순 쪽 이동, 현재 쪽 검색과 복사.
  선택을 바꾸거나 로그아웃한 뒤 도착한 이전 요청의 응답은 무시한다.
- `payments.js` — 결제 검색·환경·스토어·기간 필터, 최신순 페이지와 구매 상세.
  실제 결제만 기본 조회하며, 고객 결제나 하트 원장을 수정하는 기능은 없다.
- `ui.js` — 메뉴별 스크롤 위치, 밝은/어두운 화면 전환, 설정 검색.
- `style.css` — 밝은 화면을 기본으로 하는 반응형 레이아웃과 어두운 화면 스타일.

스크립트는 `messages.js` → `payments.js` → `app.js` → `ui.js` 순서로 읽는다. 빌드 단계는 없다.

## 결제 내역과 배포 순서

결제 메뉴 배포 전 `supabase/migrations/0288_ops_payments.sql`을 DB에 적용한다.
`ae_ops_payments`는 관리자만 읽을 수 있는 RPC이며 영수증 원문·구매 토큰은 반환하지 않는다.
조회는 `created_at DESC, id DESC` 순서이고 1페이지가 최신이다. 기본 25건씩 표시한다.

- 구매자 이름·이메일·현재 잔액, 원장에 기록된 커플, 현재 연결된 커플을 조회한다.
- 커플 ID는 구매 원장 기준이지만, 이름과 멤버 구성은 현재 값이다.
- 지급 시각은 하트 원장의 시각이다. 스토어에서 청구한 시각과 같다고 보장하지 않는다.
- `heart_prices`는 현재 KRW 참고 가격이다. 실제 결제 금액·통화·정산액은 저장되어 있지
  않으므로 추정 금액으로만 표시하고, 설정이 없으면 금액 미확인으로 표시한다.
- 스토어의 사후 현금 환불 상태는 연동되어 있지 않다. 하트 지급 완료가 환불 없음이나
  현재 보유 하트를 뜻하지 않는다. 실패·보류 중으로 지급되지 않은 결제도 원장에 없다.

배포 검증은 아래 도구로 한다. 기본 모드는 실제 스키마에서 검증 후 롤백하며, `--apply`만
관리자 조회 함수를 반영한다. 결제 엔진과 기존 구매 원장이 바뀌지 않았는지도 검사한다.

```sh
python3 tool/apply_ops_payments.py --token-file /path/to/existing-supabase-token
python3 tool/apply_ops_payments.py --token-file /path/to/existing-supabase-token --apply
```

DB 적용 후 정적 콘솔을 기존 `tool/deploy_console.sh`로 배포한다.
롤백은 이전 정적 파일 배포로 가능하며, 새 읽기 함수는 기존 앱에서 사용하지 않는다.

## 대화 조회와 배포 순서

새 대화 화면을 배포하기 전에 **`supabase/migrations/0287_ops_chat_dump_newest.sql`을
대상 DB에 적용해야 한다.** 이 마이그레이션이 `ae_ops_chat_dump_v2`를 만든다.
배포 스크립트는 정적 파일만 올리며 DB 마이그레이션을 적용하지 않는다.

`ae_ops_chat_dump_v2`는 로그인한 사용자에게 실행 권한을 주되 함수 안에서
`ae_is_admin()`을 검사하여 운영자만 대화 원문을 읽게 한다. 익명 실행 권한은 없다.
기존 `ae_ops_chat_dump`의 오래된 순서 계약은 유지하고, 새 화면은 v2만 호출한다.

- 기본 50건씩, **1쪽이 최신 대화**다. `created_at DESC, id DESC`로 순서를 고정한다.
- 첫 응답의 `snapshot` 시각을 이후 쪽 요청의 `p_snapshot`으로 보낸다.
  이후 시각에 작성된 메시지는 끼어들지 않고, 새로 읽으면 새 기준 시각을 받는다.
- 이 시각은 DB 트랜잭션 전체를 고정하는 스냅샷이 아니다.
  삭제나 과거 시각으로 추가된 행은 OFFSET 경계를 바꿀 수 있다.

마이그레이션 적용 후 `./tool/deploy_console.sh --dry`로 정적 파일 변경을 확인하고,
배포할 때 `./tool/deploy_console.sh`를 실행한다. 각 실행은 고유한 임시 체크아웃을
만들고 종료할 때 정리한다.

## 로컬 합성 데이터 미리보기

저장소 루트에서 다음 명령을 실행하고 `http://127.0.0.1:8765/`를 연다.

```sh
node tool/console_preview.mjs
```

다른 포트는 명령 뒤에 숫자를 붙이거나 `CONSOLE_PREVIEW_PORT`로 지정한다.
서버는 `127.0.0.1`에서만 열리며, 현재 `console/` 파일을 제공한다.
`tool/fixtures/console_demo.js`를 응답 HTML에만 먼저 삽입하므로 운영 파일은 바뀌지 않는다.

인증·RPC·WebSocket은 모두 합성 데이터로 응답한다. 알 수 없는 요청은 차단하고,
브라우저의 CSP도 외부 API 연결을 막는다. 실제 자격 증명이나 사용자 데이터는 필요 없다.
문의 답장·상태 변경·설정 저장은 브라우저 메모리만 바꾸며 새로고침하면 초기화된다.
이 미리보기 파일은 `console/` 밖에 있으므로 콘솔 배포 대상에 포함되지 않는다.

첫 커플은 대화 253건으로 50건씩 6쪽이며, 긴 한국어 문단·AI 응답·첨부 유형·문자열
이스케이프 예시가 있다. `?messages=empty`는 빈 대화, `?delay=1200`은 지연된 응답을
확인하는 데 쓴다. 종료는 `Ctrl+C`다.

## 회귀 테스트

별도 패키지 설치나 실제 서버 연결 없이 저장소 루트에서 실행한다.

```sh
node --test tool/tests/console_messages.test.cjs
node --test tool/tests/console_drafts.test.cjs
node --test tool/tests/console_payments.test.cjs
```

첫 테스트는 최신순 페이지·snapshot·빈 결과·오류·늦은 응답·문자열 표시를,
두 번째는 문의·설정의 초안과 저장 중 상태, 로그아웃 뒤 응답 무효화를 확인한다.
