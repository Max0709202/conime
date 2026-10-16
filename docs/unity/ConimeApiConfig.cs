// CONIME Unity 連携 参考実装（docs/unity-integration.md）。採用は任意。
// 接続設定（連携03）：local / dev / prod を環境ごとのアセットで切り替える。
// アセットは Create > CONIME > API Config で作成する。
using UnityEngine;

namespace Conime.Api
{
    [CreateAssetMenu(fileName = "ConimeApiConfig", menuName = "CONIME/API Config")]
    public sealed class ConimeApiConfig : ScriptableObject
    {
        [Tooltip("例：https://<project-ref>.supabase.co/auth/v1")]
        public string AuthBaseUrl = "http://127.0.0.1:54321/auth/v1";

        [Tooltip("例：https://<project-ref>.supabase.co/functions/v1/api/v1（Prism のローカルモックは http://127.0.0.1:4010）")]
        public string ApiBaseUrl = "http://127.0.0.1:54321/functions/v1/api/v1";

        [Tooltip("anon key（公開前提のキー）。service_role key・生成 AI のキーは絶対に入れない")]
        public string AnonKey = "";

        [Tooltip("dev のみ有効。異常系の再現（API09）。空なら送らない")]
        public string MockScenario = "";

        [Tooltip("1回の通信の待機秒数（設計02-C の仮値）")]
        public int TimeoutSeconds = 15;
    }
}
