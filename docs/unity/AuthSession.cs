// 認証（認証01）：Supabase Auth のメールアドレス＋パスワード。アクセストークン（1時間）はメモリのみ、
// リフレッシュトークン（使い捨て・更新時に再発行）は iOS キーチェーンに保存する
using System;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine.Networking;

namespace Conime.Api
{
    // iOS キーチェーンへの保存（ネイティブプラグイン経由）。エディタでは代替実装を使う
    public interface ISecureStore
    {
        string Get(string key);
        void Set(string key, string value);
        void Delete(string key);
    }

    public sealed class AuthSession
    {
        const string RefreshTokenKey = "conime.refresh_token";

        readonly ConimeApiConfig _config;
        readonly ISecureStore _store;
        Task<bool> _refreshing;

        public string AccessToken { get; private set; }
        public string UserId { get; private set; }
        public bool HasStoredSession => !string.IsNullOrEmpty(_store.Get(RefreshTokenKey));

        // リフレッシュに失敗したら再ログイン画面へ（AC-1）
        public event Action LoginRequired;

        public AuthSession(ConimeApiConfig config, ISecureStore store)
        {
            _config = config;
            _store = store;
        }

        public sealed class AuthError
        {
            [JsonProperty("code")] public int Code;
            [JsonProperty("error_code")] public string ErrorCode; // invalid_credentials / user_already_exists / weak_password 等
            [JsonProperty("msg")] public string Message;
        }

        // サインアップ（dev はメール確認なしでトークンが返る・U-02）
        public Task<AuthError> SignUpAsync(string email, string password, string displayName = null) =>
            TokenRequestAsync("/signup", new JObject
            {
                ["email"] = email,
                ["password"] = password,
                ["data"] = new JObject { ["display_name"] = displayName },
            });

        public Task<AuthError> SignInAsync(string email, string password) =>
            TokenRequestAsync("/token?grant_type=password", new JObject { ["email"] = email, ["password"] = password });

        // 同時に複数の要求が 401 を受けても、リフレッシュは1回だけ行う
        public Task<bool> RefreshAsync()
        {
            if (_refreshing != null) return _refreshing;
            _refreshing = DoRefreshAsync();
            _refreshing.ContinueWith(_ => _refreshing = null);
            return _refreshing;
        }

        async Task<bool> DoRefreshAsync()
        {
            var refresh = _store.Get(RefreshTokenKey);
            if (string.IsNullOrEmpty(refresh)) return false;
            var err = await TokenRequestAsync("/token?grant_type=refresh_token", new JObject { ["refresh_token"] = refresh });
            if (err != null && err.Code >= 400 && err.Code < 500) _store.Delete(RefreshTokenKey);
            return err == null;
        }

        public async Task SignOutAsync()
        {
            if (!string.IsNullOrEmpty(AccessToken))
            {
                using var req = new UnityWebRequest(_config.AuthBaseUrl + "/logout", "POST");
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("apikey", _config.AnonKey);
                req.SetRequestHeader("Authorization", "Bearer " + AccessToken);
                await req.SendWebRequest();
            }
            AccessToken = null;
            UserId = null;
            _store.Delete(RefreshTokenKey);
        }

        internal void RaiseLoginRequired() => LoginRequired?.Invoke();

        async Task<AuthError> TokenRequestAsync(string path, JObject body)
        {
            using var req = new UnityWebRequest(_config.AuthBaseUrl + path, "POST");
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body.ToString(Formatting.None)));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.timeout = _config.TimeoutSeconds;
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("apikey", _config.AnonKey);
            await req.SendWebRequest();

            if (req.result == UnityWebRequest.Result.ConnectionError)
                return new AuthError { Code = 0, ErrorCode = ErrorCodes.NetworkError, Message = req.error };
            var json = JObject.Parse(string.IsNullOrEmpty(req.downloadHandler.text) ? "{}" : req.downloadHandler.text);
            if (req.responseCode != 200)
                return json.ToObject<AuthError>() ?? new AuthError { Code = (int)req.responseCode };

            AccessToken = (string)json["access_token"];
            UserId = (string)json["user"]?["id"];
            _store.Set(RefreshTokenKey, (string)json["refresh_token"]);
            return null;
        }
    }
}
