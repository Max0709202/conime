// 登録から結果取得までの流れ（認証02・API05・連携04）の参考実装
//   (1) GET /question-sets/current → (3) 回答を端末に保存（送信しない）
//   (4) サインアップ → (6)(8) 同意 → (10) POST /diagnoses ＋ Idempotency-Key → 生成待ち → 結果
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Conime.Api.Models;
using Newtonsoft.Json;
using UnityEngine;

namespace Conime.Api
{
    // 登録前の回答は端末のみに保存する（前提条件）。冪等キーは回答と一緒に保存し、再起動後の再送でも同じ値を使う
    [Serializable]
    public sealed class PendingDiagnosis
    {
        public string QuestionSetId;
        public int QuestionSetVersion;
        public string IdempotencyKey;
        public List<Answer> Answers = new List<Answer>();
        public DateTime AnsweredAt;

        const string Key = "conime.pending_diagnosis";

        public void Save() => PlayerPrefs.SetString(Key, JsonConvert.SerializeObject(this, ApiClient.JsonSettings));
        public static PendingDiagnosis Load() =>
            PlayerPrefs.HasKey(Key) ? JsonConvert.DeserializeObject<PendingDiagnosis>(PlayerPrefs.GetString(Key), ApiClient.JsonSettings) : null;
        public static void Clear() => PlayerPrefs.DeleteKey(Key);
    }

    public sealed class DiagnosisFlow
    {
        readonly ApiClient _api;
        public DiagnosisFlow(ApiClient api) => _api = api;

        // 質問定義の取得。question_set.id と version を回答と一緒に端末保存する
        public async Task<QuestionSetResponse> LoadQuestionsAsync()
        {
            var r = await _api.GetAsync<QuestionSetResponse>("/question-sets/current");
            return r.Ok ? r.Data : null;
        }

        public PendingDiagnosis StartAnswering(QuestionSetResponse set) => new PendingDiagnosis
        {
            QuestionSetId = set.QuestionSet.Id,
            QuestionSetVersion = set.QuestionSet.Version,
            IdempotencyKey = Guid.NewGuid().ToString(), // 「1つの操作」ごとに生成
        };

        // 同意画面：最新の同意文書をすべて granted で記録する（文言の表示は画面側）
        public async Task<bool> AgreeAllAsync()
        {
            var docs = await _api.GetAsync<List<ConsentDocument>>("/consent-documents/current");
            if (!docs.Ok) return false;
            var body = new ConsentRecordRequest { AppVersion = Application.version };
            foreach (var d in docs.Data) body.Consents.Add(new ConsentDecision { DocumentId = d.Id, Decision = "granted" });
            var r = await _api.PostAsync<ConsentStatus>("/me/consents", body, Guid.NewGuid().ToString());
            return r.Ok && r.Data.AiTransferGranted;
        }

        public enum SubmitOutcome { Accepted, ConsentRequired, Outdated, Invalid, Failed }

        public async Task<(SubmitOutcome outcome, string submissionId)> SubmitAsync(PendingDiagnosis pending)
        {
            var body = new DiagnosisSubmitRequest
            {
                QuestionSetId = pending.QuestionSetId,
                QuestionSetVersion = pending.QuestionSetVersion,
                Answers = pending.Answers,
                AnsweredAt = pending.AnsweredAt,
            };
            var r = await _api.PostAsync<DiagnosisAccepted>("/diagnoses", body, pending.IdempotencyKey);
            if (r.Ok) return (SubmitOutcome.Accepted, r.Data.SubmissionId);
            switch (r.ErrorCode)
            {
                case ErrorCodes.ConsentRequired: return (SubmitOutcome.ConsentRequired, null); // 同意画面へ戻す
                case ErrorCodes.AlreadySubmitted: // 送信済み：details の submission_id で状態取得へ
                    return (SubmitOutcome.Accepted, (string)r.Error.Details[0]["submission_id"]);
                case ErrorCodes.QuestionSetOutdated: return (SubmitOutcome.Outdated, null); // 定義を再取得し変更分を再回答
                case ErrorCodes.ValidationError: return (SubmitOutcome.Invalid, null);      // details に項目ごとの理由
                default: return (SubmitOutcome.Failed, null);                               // 手動再試行（同じ冪等キーで）
            }
        }

        // 生成待ち：poll_after_seconds ごとに状態を取得する（何度呼んでも生成は重複しない）
        public async Task<DiagnosisStatus> WaitForCompletionAsync(string submissionId, Action<DiagnosisStatus> onProgress = null)
        {
            while (true)
            {
                var r = await _api.GetAsync<DiagnosisStatus>("/diagnoses/" + submissionId);
                if (!r.Ok) return null;
                onProgress?.Invoke(r.Data);
                if (r.Data.Status == "completed" || r.Data.Status == "failed") return r.Data;
                await Task.Delay(TimeSpan.FromSeconds(r.Data.PollAfterSeconds ?? 3));
            }
        }

        // failed のとき：再試行ボタン → POST /diagnoses/{id}/retry（回答の再送は不要）
        public async Task<bool> RetryAsync(string submissionId)
        {
            var r = await _api.PostAsync<DiagnosisStatus>("/diagnoses/" + submissionId + "/retry", null, Guid.NewGuid().ToString());
            return r.Ok || r.ErrorCode == ErrorCodes.GenerationInProgress;
        }

        // 結果画面（SC-03・SC-04）。completed になったら1回で取得する
        public async Task<DiagnosisResult> LoadResultAsync()
        {
            var r = await _api.GetAsync<DiagnosisResult>("/me/diagnosis-result");
            if (r.Ok) PendingDiagnosis.Clear();
            return r.Ok ? r.Data : null;
        }

        // 命名（Q-4）。変更できるのは名前のみ
        public async Task<Character> RenameAsync(string name)
        {
            var r = await _api.PatchAsync<Character>("/me/character", new RenameCharacterRequest { Name = name });
            return r.Ok ? r.Data : null;
        }
    }
}
