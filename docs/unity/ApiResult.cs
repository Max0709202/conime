// 応答形式（API01）：成功は data（一覧は meta）、失敗は error。分岐は HTTP ステータスではなく error.code で行う（API02）
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Conime.Api
{
    public static class ErrorCodes
    {
        public const string ValidationError = "VALIDATION_ERROR";
        public const string Unauthenticated = "UNAUTHENTICATED";
        public const string TokenExpired = "TOKEN_EXPIRED";
        public const string ConsentRequired = "CONSENT_REQUIRED";
        public const string Forbidden = "FORBIDDEN";
        public const string AccountWithdrawn = "ACCOUNT_WITHDRAWN";
        public const string NotFound = "NOT_FOUND";
        public const string AlreadySubmitted = "ALREADY_SUBMITTED";
        public const string QuestionSetOutdated = "QUESTION_SET_OUTDATED";
        public const string DuplicateGoodto = "DUPLICATE_GOODTO";
        public const string GuildFull = "GUILD_FULL";
        public const string GuildLimitReached = "GUILD_LIMIT_REACHED";
        public const string AlreadyMember = "ALREADY_MEMBER";
        public const string GenerationInProgress = "GENERATION_IN_PROGRESS";
        public const string IdempotencyKeyReused = "IDEMPOTENCY_KEY_REUSED";
        public const string RateLimited = "RATE_LIMITED";
        public const string InternalError = "INTERNAL_ERROR";
        public const string AiUnavailable = "AI_UNAVAILABLE";
        // アプリ側で付ける（サーバーは返さない）
        public const string NetworkError = "NETWORK_ERROR";
    }

    public sealed class ApiErrorBody
    {
        [JsonProperty("code")] public string Code;
        [JsonProperty("message")] public string Message; // 開発者向け。画面文言には使わない
        [JsonProperty("details")] public List<JObject> Details = new List<JObject>();
        [JsonProperty("request_id")] public string RequestId;
    }

    public sealed class ApiResult<T>
    {
        public long Status;
        public T Data;
        public JObject Meta;
        public ApiErrorBody Error;
        public string RetryAfter;
        public string Location;

        public bool Ok => Error == null && Status >= 200 && Status < 300;
        public string ErrorCode => Error?.Code;

        internal static ApiResult<T> FromResponse(long status, string text, string retryAfter, string location)
        {
            var result = new ApiResult<T> { Status = status, RetryAfter = retryAfter, Location = location };
            if (status == 204 || status == 304 || string.IsNullOrEmpty(text)) return result;
            try
            {
                var json = JObject.Parse(text);
                if (json.TryGetValue("error", out var err))
                {
                    result.Error = err.ToObject<ApiErrorBody>(ApiClient.Serializer);
                }
                else
                {
                    if (json.TryGetValue("data", out var data)) result.Data = data.ToObject<T>(ApiClient.Serializer);
                    result.Meta = json["meta"] as JObject;
                }
            }
            catch (JsonException)
            {
                result.Error = new ApiErrorBody { Code = ErrorCodes.InternalError, Message = "invalid JSON response" };
            }
            return result;
        }

        internal static ApiResult<T> Network(string message) =>
            new ApiResult<T> { Status = 0, Error = new ApiErrorBody { Code = ErrorCodes.NetworkError, Message = message } };
    }
}
