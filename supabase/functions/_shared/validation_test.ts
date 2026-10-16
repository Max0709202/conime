// 診断回答の入力検証（API07）の単体テスト：deno test supabase/functions
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { type QuestionDefinition, validateAnswers } from "./validation.ts";

const Q: QuestionDefinition[] = [
  { id: "q1", code: "Q1", answer_type: "free_fields", is_required: true, constraints: { field_count: 3, required_field_count: 3, max_length: 50 }, option_codes: [] },
  { id: "q6", code: "Q6", answer_type: "single_choice", is_required: true, constraints: {}, option_codes: ["A", "B", "C", "D"] },
  { id: "q7", code: "Q7", answer_type: "free_multi", is_required: true, constraints: { max_length: 200 }, option_codes: [] },
  { id: "q9", code: "Q9", answer_type: "multi_choice", is_required: true, constraints: { min_select: 1, max_select: 3 }, option_codes: ["A", "B", "C", "D", "E"] },
  { id: "q10", code: "Q10", answer_type: "free_fields", is_required: false, constraints: { field_count: 1, max_length: 10 }, option_codes: [] },
];
const valid = () => [
  { question_code: "Q1", texts: ["作品A", "作品B", "作品C"] },
  { question_code: "Q6", option_codes: ["B"] },
  { question_code: "Q7", texts: ["作品D、作品E"] },
  { question_code: "Q9", option_codes: ["A", "C", "D"] },
];
const reasons = (answers: ReturnType<typeof valid>) => validateAnswers(Q, answers).errors.map((e) => e.reason);

Deno.test("有効な回答は回答をそのまま正規化する（任意の質問は省略可）", () => {
  const { errors, normalized } = validateAnswers(Q, valid());
  assertEquals(errors, []);
  assertEquals(normalized[0], { question_id: "q1", option_codes: [], texts: ["作品A", "作品B", "作品C"] });
});

Deno.test("回答の網羅：必須質問の欠落・未知の code・重複", () => {
  assertEquals(reasons(valid().filter((a) => a.question_code !== "Q1")), ["required_question_missing"]);
  assertEquals(reasons([...valid(), { question_code: "Q99", texts: ["x"] }]), ["unknown_question"]);
  assertEquals(reasons([...valid(), { question_code: "Q6", option_codes: ["A"] }]), ["duplicate_question"]);
});

Deno.test("single_choice：ちょうど1つ・定義済みの code", () => {
  const a = valid();
  a[1].option_codes = ["A", "B"];
  assertEquals(reasons(a), ["exactly_one"]);
  a[1].option_codes = ["Z"];
  assertEquals(reasons(a), ["unknown_option"]);
});

Deno.test("multi_choice：min_select〜max_select・重複なし", () => {
  const a = valid();
  a[3].option_codes = ["A", "B", "C", "D"];
  assertEquals(reasons(a), ["max_select"]);
  a[3].option_codes = [];
  assertEquals(reasons(a), ["min_select"]);
  a[3].option_codes = ["A", "A"];
  assertEquals(reasons(a), ["duplicate_option"]);
});

Deno.test("free_fields：要素数 = field_count・必須欄は空白のみ不可・max_length（コードポイント数）", () => {
  const a = valid();
  a[0].texts = ["作品A", "作品B"];
  assertEquals(reasons(a), ["field_count"]);
  a[0].texts = ["作品A", "　 ", "作品C"];
  assertEquals(reasons(a), ["required"]);
  a[0].texts = ["😀".repeat(50), "作品B", "作品C"];
  assertEquals(reasons(a), []);
  a[0].texts = ["😀".repeat(51), "作品B", "作品C"];
  assertEquals(reasons(a), ["max_length"]);
});

Deno.test("free_multi：1要素・max_length 以内", () => {
  const a = valid();
  a[2].texts = ["a", "b"];
  assertEquals(reasons(a), ["field_count"]);
  a[2].texts = ["あ".repeat(201)];
  assertEquals(reasons(a), ["max_length"]);
});
