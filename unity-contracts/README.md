# Unity hand-off contracts

| Path | Content |
|------|---------|
| `Generated/ConimeApiDtos.cs` | Plain `[Serializable]` C# DTOs for every request/response schema, generated from `openapi/openapi.yaml` (`deno run -A scripts/generate-csharp-dtos.ts`). Do not edit by hand. |
| `Examples/ConimeApiClient.cs` | **Example only**: `UnityWebRequest` calls with timeout, retries reusing the `Idempotency-Key`, error-envelope parsing, token-refresh hook and signed upload. No UI and no token storage. |

Serializer: Newtonsoft.Json (`com.unity.nuget.newtonsoft-json`). For IL2CPP builds, keep the DTOs from being stripped, for example with `link.xml`:

```xml
<linker><assembly fullname="Assembly-CSharp"><namespace fullname="Conime.Api.Dto" preserve="all"/></assembly></linker>
```

Linux verification: `tests/unity-contracts` compiles the DTOs with .NET 8 / C# 9 and deserializes 22 real API responses in strict mode (`MissingMemberHandling.Error`) with a lossless round trip. This is **not** a Unity/IL2CPP/iOS test; see `docs/IOS_VALIDATION_CHECKLIST.md` items 1–2.
