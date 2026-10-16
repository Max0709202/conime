// 通信の決まりごと（連携03・連携05）
//   1. 全要求に apikey と X-Client-Version、会員 API に Authorization を付ける
//   2. 作成系 POST は操作ごとに UUID を Idempotency-Key に入れ、再試行でも同じ値を使う
//   3. 分岐は HTTP ステータスではなく error.code で行う
//   4. 相性%・EXP・レベル・グッと累計は応答の値をそのまま使い、アプリで計算しない
//
//   | 状況                         | 自動再試行                    | 扱い                         |
//   | 通信断・15秒超過・500・503   | する（最大2回：2秒後・5秒後） | 上限後は手動再試行           |
//   | 429                          | Retry-After 秒後に1回         | その後は案内                 |
//   | 400・403・404・409・422      | しない                        | error.code に応じた案内      |
//   | 401 TOKEN_EXPIRED            | リフレッシュ後に1回           | 失敗時は再ログイン画面へ     |
using System;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using UnityEngine;
using UnityEngine.Networking;

namespace Conime.Api
{
    public sealed class ApiClient
    {
        // snake_case・未知の項目は無視（後方互換のための項目追加に備える）
        public static readonly JsonSerializerSettings JsonSettings = new JsonSerializerSettings
        {
            ContractResolver = new DefaultContractResolver { NamingStrategy = new SnakeCaseNamingStrategy() },
            MissingMemberHandling = MissingMemberHandling.Ignore,
            NullValueHandling = NullValueHandling.Ignore,
            DateTimeZoneHandling = DateTimeZoneHandling.Utc,
        };
        public static readonly JsonSerializer Serializer = JsonSerializer.Create(JsonSettings);

        static readonly int[] RetryDelaysSeconds = { 2, 5 };

        readonly ConimeApiConfig _config;
        readonly AuthSession _session;

        public ApiClient(ConimeApiConfig config, AuthSession session)
        {
            _config = config;
            _session = session;
        }

        public Task<ApiResult<T>> GetAsync<T>(string path) => SendAsync<T>("GET", path);
        public Task<ApiResult<T>> PostAsync<T>(string path, object body = null, string idempotencyKey = null) =>
            SendAsync<T>("POST", path, body, idempotencyKey);
        public Task<ApiResult<T>> PatchAsync<T>(string path, object body) => SendAsync<T>("PATCH", path, body);
        public Task<ApiResult<T>> DeleteAsync<T>(string path) => SendAsync<T>("DELETE", path);

        public async Task<ApiResult<T>> SendAsync<T>(string method, string path, object body = null,
            string idempotencyKey = null, bool refreshed = false)
        {
            ApiResult<T> result = null;
            for (var attempt = 0; attempt <= RetryDelaysSeconds.Length; attempt++)
            {
                result = await SendOnceAsync<T>(method, path, body, idempotencyKey);

                // 401 TOKEN_EXPIRED → リフレッシュを1回行い、元の要求を1回だけ再送（設計02-A (5)）
                if (result.ErrorCode == ErrorCodes.TokenExpired && !refreshed)
                {
                    if (await _session.RefreshAsync()) return await SendAsync<T>(method, path, body, idempotencyKey, true);
                    _session.RaiseLoginRequired();
                    return result;
                }
                // 429 → Retry-After 秒後に1回
                if (result.ErrorCode == ErrorCodes.RateLimited && attempt == 0)
                {
                    var wait = int.TryParse(result.RetryAfter, out var s) ? s : 10;
                    await Task.Delay(TimeSpan.FromSeconds(wait));
                    return await SendOnceAsync<T>(method, path, body, idempotencyKey);
                }
                if (!IsRetryable(result) || attempt == RetryDelaysSeconds.Length) break;
                // 同じ Idempotency-Key で再送するため、サーバー側で処理は二重に実行されない
                await Task.Delay(TimeSpan.FromSeconds(RetryDelaysSeconds[attempt]));
            }
            return result;
        }

        static bool IsRetryable<T>(ApiResult<T> r) =>
            r.ErrorCode == ErrorCodes.NetworkError || r.Status == 500 || r.Status == 503;

        async Task<ApiResult<T>> SendOnceAsync<T>(string method, string path, object body, string idempotencyKey)
        {
            using var req = new UnityWebRequest(_config.ApiBaseUrl + path, method);
            if (body != null)
            {
                var json = JsonConvert.SerializeObject(body, JsonSettings);
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
                req.SetRequestHeader("Content-Type", "application/json");
            }
            req.downloadHandler = new DownloadHandlerBuffer();
            req.timeout = _config.TimeoutSeconds;
            req.SetRequestHeader("apikey", _config.AnonKey);
            req.SetRequestHeader("X-Client-Version", Application.version);
            if (!string.IsNullOrEmpty(_session.AccessToken))
                req.SetRequestHeader("Authorization", "Bearer " + _session.AccessToken);
            if (!string.IsNullOrEmpty(idempotencyKey))
                req.SetRequestHeader("Idempotency-Key", idempotencyKey);
            if (!string.IsNullOrEmpty(_config.MockScenario))
                req.SetRequestHeader("X-Mock-Scenario", _config.MockScenario);

            await req.SendWebRequest();

            if (req.result == UnityWebRequest.Result.ConnectionError)
                return ApiResult<T>.Network(req.error); // 通信断・タイムアウト
            return ApiResult<T>.FromResponse(req.responseCode, req.downloadHandler.text,
                req.GetResponseHeader("Retry-After"), req.GetResponseHeader("Location"));
        }
    }

    // UnityWebRequestAsyncOperation を await できるようにする（Unity 2023.1 未満向け）
    public static class UnityWebRequestAwaiterExtensions
    {
        public static TaskAwaiter<AsyncOperation> GetAwaiter(this UnityWebRequestAsyncOperation op)
        {
            var tcs = new TaskCompletionSource<AsyncOperation>();
            if (op.isDone) tcs.SetResult(op);
            else op.completed += o => tcs.TrySetResult(o);
            return tcs.Task.GetAwaiter();
        }
    }
}
