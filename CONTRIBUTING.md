# 기여 안내

이슈와 PR 모두 환영합니다. 다만 이 저장소는 개발 저장소에서 내보낸 공개 코어라서, 받아들인 PR은 개발 저장소에 옮겨 반영한 뒤 다음 릴리스로 다시 내보냅니다. 그래서 PR이 그대로 머지되지 않고 닫힐 수 있습니다.

## 개발 환경

[사용 설명서 › 요구 사항](docs/guide.md#요구-사항)과 같습니다(Linux, Bun, bun 패키지로 설치한 omp).

```sh
bun install
bun test          # 0 fail이어야 합니다(실제 omp E2E는 기본으로 건너뜁니다)
bun run check     # biome + tsc
```

실제 omp를 띄우는 E2E는 `OMPBOT_E2E_OMP=1 bun test`로 돌리며, 모델 호출 비용이 듭니다.

## PR을 보내기 전에

- `bun test`와 `bun run check`가 모두 통과해야 합니다.
- 동작을 바꾸면 그 동작을 확인하는 테스트를 같은 PR에 넣어 주세요. 문구만 바꾼 변경에는 테스트가 필요 없습니다.
- 설정 키·명령·출력 형식이 바뀌면 [docs/guide.md](docs/guide.md)도 같이 고쳐 주세요.
- 토큰, 실제 Slack ID, 호스트 이름 같은 개인 식별자는 넣지 마세요. 예시는 `U0123456789`, `C0123456789`처럼 자리표시자를 씁니다.

## 보안 문제

공개 이슈 대신 [SECURITY.md](SECURITY.md)의 방법으로 알려 주세요.
