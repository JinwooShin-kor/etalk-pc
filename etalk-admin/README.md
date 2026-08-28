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
| 서버 함수 | `ae_ops_*` — 마이그레이션 0238 · 0239 · 0240 |

**배포본을 직접 고치지 마라.** 다음 배포에 덮인다.

## 파일

- `index.html` — 뼈대. 탭과 카드 자리만 있다.
- `app.js` — 전부. 서버 함수를 부르고 그린다. 여기서 숫자를 다시 세지 않는다.
- `style.css` — 어두운 판 기본, 밝은 판은 `prefers-color-scheme` 으로.

빌드 단계가 없다. 고치고 `deploy_console.sh` 만 돌리면 된다.
