// 第1段階の実動作 API の DTO（openapi/openapi.yaml と同じ項目名・snake_case は ApiClient.JsonSettings で変換）。
// 未知の項目は無視する。モック API の DTO は openapi.yaml から同じ要領で追加する
using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace Conime.Api.Models
{
    // ---------------------------------------------------------------- 質問定義（GET /question-sets/current）
    public sealed class QuestionSetResponse
    {
        public QuestionSetInfo QuestionSet;
        public List<Question> Questions;
    }

    public sealed class QuestionSetInfo
    {
        public string Id;
        public int Version;
        public DateTime PublishedAt;
    }

    public sealed class Question
    {
        public string Id;
        public string Code;          // Q1〜Q20
        public int Order;
        public string Title;
        public string AnswerType;    // single_choice / multi_choice / free_fields / free_multi
        public bool Required;
        public QuestionConstraints Constraints;
        public List<string> Usages;
        public List<QuestionOption> Options;
    }

    public sealed class QuestionConstraints
    {
        public int? MinSelect;
        public int? MaxSelect;
        public int? FieldCount;
        public int? RequiredFieldCount;
        public int? MaxLength;       // 文字数は Unicode のコードポイント数
    }

    public sealed class QuestionOption
    {
        public string Code;
        public string Label;
    }

    // ---------------------------------------------------------------- 同意
    public sealed class ConsentDocument
    {
        public string Id;
        public string DocType;       // terms / privacy / ai_transfer
        public int Version;
        public string Title;
        public string Body;
        public bool RequiresReconsent;
        public DateTime PublishedAt;
    }

    public sealed class ConsentRecordRequest
    {
        public List<ConsentDecision> Consents = new List<ConsentDecision>();
        public string AppVersion;
    }

    public sealed class ConsentDecision
    {
        public string DocumentId;
        public string Decision;      // granted / revoked
    }

    public sealed class ConsentStatus
    {
        public bool AllGranted;
        public bool AiTransferGranted;
        public List<ConsentStatusItem> Items;
    }

    public sealed class ConsentStatusItem
    {
        public string DocType;
        public string DocumentId;
        public int Version;
        public string Title;
        public bool RequiresReconsent;
        public string Status;        // granted / revoked / not_decided / reconsent_required
        public string ConsentId;
        public DateTime? DecidedAt;
    }

    // ---------------------------------------------------------------- 自分の状態（GET /me）
    public sealed class Me
    {
        public string UserId;
        public string Email;
        public string DisplayName;
        public string Role;
        public string Status;
        public MeConsents Consents;
        public MeDiagnosis Diagnosis;
        public bool HasCharacter;
        public string NextAction;    // consent_required / diagnosis_required / generating / retry_required / ready
    }

    public sealed class MeConsents
    {
        public bool AllGranted;
        public bool AiTransferGranted;
    }

    public sealed class MeDiagnosis
    {
        public string Status;        // not_submitted / received / processing / completed / failed
        public string SubmissionId;
    }

    // ---------------------------------------------------------------- 診断
    public sealed class DiagnosisSubmitRequest
    {
        public string QuestionSetId;
        public int QuestionSetVersion;
        public List<Answer> Answers = new List<Answer>();
        public DateTime? AnsweredAt;
    }

    public sealed class Answer
    {
        public string QuestionCode;
        public List<string> OptionCodes; // 選択式
        public List<string> Texts;       // 自由記述（free_multi は1要素。区切りの解析はサーバー）
    }

    public sealed class DiagnosisAccepted
    {
        public string SubmissionId;
        public string Status;
        public DateTime SubmittedAt;
        public int PollAfterSeconds;
    }

    public sealed class DiagnosisStatus
    {
        public string SubmissionId;
        public string Status;        // received / processing / completed / failed
        public DateTime SubmittedAt;
        public DateTime? CompletedAt;
        public string ErrorCode;
        public int? PollAfterSeconds;
        public bool Retryable;
    }

    public sealed class DiagnosisResult
    {
        public SubmissionRef Submission;
        public ProfileResult Profile;
        public CharacterSummary Character; // 生成前は null
        public CharacterImage Image;
        public RecommendationsResult Recommendations;
    }

    public sealed class SubmissionRef
    {
        public string SubmissionId;
        public string Status;
    }

    public sealed class ProfileResult
    {
        public string Status;        // pending / ready / failed
        public string Personality;
        public List<ProfileItem> Items;
        public List<string> AiComments;
    }

    public sealed class ProfileItem
    {
        public string Key;
        public string Label;
        public List<string> Values;
    }

    public sealed class RecommendationsResult
    {
        public string Status;        // pending / ready（第1段階は pending）
        public List<JObject> Works;
        public List<JObject> Guilds;
        public List<JObject> Users;
    }

    // ---------------------------------------------------------------- キャラクター
    public class CharacterSummary
    {
        public string PublicCode;    // C- ＋ 英数字8文字（画面表示用キャラID）
        public string Name;          // 初回は null → PATCH /me/character で命名
        public int Level;
        public string Species;
        public string Class;
        public string Attribute;
        public string Rarity;
        public string Title;
        public string Personality;
        public List<string> Strengths;
        public List<string> Weaknesses;
        public List<Skill> Skills;
        public JObject Extra;        // 表示項目の追加用。未知のキーは無視
    }

    public sealed class Skill
    {
        public string Name;
        public string Description;
    }

    public sealed class Character
    {
        public string PublicCode;
        public string Name;
        public string Species;
        public string Class;
        public string Attribute;
        public string Rarity;
        public string Title;
        public int Level;
        public int MaxLevel;
        public int ExpTotal;         // 計算はサーバー。アプリは表示のみ
        public int GoodtoPoints;
        public string Personality;
        public List<string> Strengths;
        public List<string> Weaknesses;
        public List<Skill> Skills;
        public JObject StatusItems;
        public CharacterImage Image;
        public DateTime CreatedAt;
    }

    public sealed class CharacterImage
    {
        public string Status;        // none / generating / ready / failed
        public string Url;           // 署名付き URL（1時間）。期限が切れたら再取得
        public DateTime? ExpiresAt;
        public int Stage;
    }

    public sealed class RenameCharacterRequest
    {
        public string Name;          // 1〜20文字（U-07）
    }
}
