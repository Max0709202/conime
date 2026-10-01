# iOS / Unity Validation Checklist (EXTERNAL)

**These are external integration tests.** They must be performed by the frontend engineer or the client on macOS with Unity, the iOS Simulator and at least one physical iPhone. **None of them has been executed by the backend developer**, who has no Mac or iPhone. Linux backend verification (see `TEST_REPORT.md`) does not replace them.

Record the results in the table (device, iOS version, Unity version, build number, date, tester, result, notes / request IDs).

Environment for all tests: staging backend, seeded test accounts (see `postman/README.md`), staging Supabase URL and publishable key.

| # | Area | Test | Pass criteria | Result |
|---|------|------|---------------|--------|
| 1 | JSON | Deserialize every response type with the generated DTOs in a **device (IL2CPP) build** | No exceptions; nullable fields stay null; dictionaries (`stats`, `visual_elements`, `details`, `data`) populate; Japanese text intact. With IL2CPP managed stripping, add a `link.xml` or use `[Preserve]` so DTO fields are not stripped | |
| 2 | JSON | Serialize requests (diagnosis answers, messages) | Server returns 2xx; no `VALIDATION_ERROR` caused by casing or extra fields | |
| 3 | Auth | Sign in with Apple (native) → `signInWithIdToken` | `/v1/me` returns 200; nonce flow correct | |
| 4 | Auth | Sign in with Google (native) | As above | |
| 5 | Auth | Auth callback / deep link (`conime://auth-callback`) if a browser flow is used | App resumes with a session | |
| 6 | Tokens | Secure persistence (Keychain); relaunch the app | Session restored without re-login; no tokens in PlayerPrefs or logs | |
| 7 | Tokens | Token refresh before expiry and after `TOKEN_EXPIRED` | Request succeeds after one refresh; refresh-token rotation stored | |
| 8 | Lifecycle | Background for > 1 h, then resume | Session refreshed; realtime re-joined; missed messages fetched (`after_seq`) | |
| 9 | Network | Airplane mode during send; then restore | Pending bubble shown; retry uses the same `client_message_id` and `Idempotency-Key`; exactly one message on the server | |
| 10 | Network | Kill network during diagnosis submission | No duplicate submission; job continues; polling resumes | |
| 11 | Realtime | Two devices in the same guild room | Messages appear on the other device within about 2 s | |
| 12 | Realtime | Disconnect Wi-Fi on one device, send 3 messages from the other, reconnect | All 3 appear once, in order, after reconnect | |
| 13 | Realtime | Token refresh while the socket is open | Channels stay subscribed; no auth errors | |
| 14 | Images | Photo picker → upload (JPEG and HEIC) → image message | Upload completes; the other member can view the image; oversized files show the size message | |
| 15 | Images | Character image display, signed URL expiry (> 1 h) | Image reloads with a fresh URL; placeholder on failure (D-5) | |
| 16 | Text | Long Japanese text (1,000 characters), emoji, full-width symbols, line breaks | Sent and displayed unchanged; limit enforced as `/v1/app-config` says | |
| 17 | Text | IME composition (かな漢字変換) in message and name inputs | No partial submissions; NFKC on names is acceptable to the client | |
| 18 | Errors | Force each common error (full guild, blocked DM, duplicate グッと, outdated question set) | Correct Japanese message; no freeze (AC-1, C-3, G-3) | |
| 19 | UI | Safe area on supported iPhones (portrait, about 19.5:9) | No clipping (D-6). Backend not involved; listed for completeness | |
| 20 | Build | Xcode compile, signing, provisioning | Archive succeeds | |
| 21 | Simulator | Smoke test: sign-in → diagnosis → character → guild join → chat → グッと | All steps succeed against staging | |
| 22 | Device | Same smoke test on at least one physical iPhone | All steps succeed; record `X-Request-Id` values for any errors | |
| 23 | Deletion | Account deletion from settings (SC-23) | 202 shown; app signs out; re-login impossible | |
| 24 | Privacy | Pre-registration answers are not sent before sign-up and consent | Proxy log (e.g. Charles/Proxyman) shows no answer payload before consent | |
| 25 | Privacy | Photos uploaded to chat have EXIF location removed (the server stores images unchanged; KNOWN_LIMITATIONS L-10) | Downloaded image contains no GPS EXIF (`exiftool`) | |

## Optional CI for the Unity project (template, not required)

If the frontend project uses GitHub Actions with a macOS runner or Unity Build Automation:

```yaml
# .github/workflows/unity-ios.yml (in the Unity repository)
on: [push]
jobs:
  build-ios:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
        with: { lfs: true }
      - uses: game-ci/unity-builder@v4
        env:
          UNITY_LICENSE: ${{ secrets.UNITY_LICENSE }}
          UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}
          UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}
        with:
          targetPlatform: iOS
          unityVersion: 6000.5.0f1
      # Then: xcodebuild archive / fastlane (Apple Developer account owned by the client)
```

The backend developer does not need a Mac, iPhone or Apple Developer account for this template to exist.
