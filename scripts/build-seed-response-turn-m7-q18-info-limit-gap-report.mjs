// Turn M7 Section 5: before writing any new rendering code, this checks
// whether the EXISTING generic information-limit path can express Q18's
// required sentence ("발행주식 수·주당 발행가액은 확인되지만 발행총액은 원문
// 직접 공시 항목으로 확인되지 않는다"). Finding: it cannot, for a reason
// that generalizes beyond Q18 (documented below) -- per the Owner's
// explicit instruction, this is reported as an IMPLEMENTATION_GAP and no
// new framework/Q18-specific branch is added this Turn.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl");
const OUT_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m7-q18-info-limit-implementation-gap.v0.1.json");

function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`Q18_INFO_LIMIT_GAP_REPORT_BLOCKED: ${msg}`); }

async function main() {
  const planRows = jsonl((await readFile(PLAN_PATH)).toString("utf8"));
  const q18Plan = planRows.find((r) => r.question_id === "question_seed_v07_18");
  if (!q18Plan) fail("question_seed_v07_18 not found in Plan v0.11");
  const hasIssuanceAmountSlot = (q18Plan.slots ?? []).some((s) => /issuance_amount/i.test(s.slot_name));

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "M7",
    subject: "Q18 발행총액 information-limit rendering",
    question_examined: "question_seed_v07_18",
    mechanism_examined: {
      renderer: "domain/flows/synthesis/response-composer.mjs:renderInformationLimitSentences",
      driven_by: "domain/flows/synthesis/narrative-field-extractor.mjs:extractNarrativeFields -> information_limits array",
      populated_from: "signals.information_limit_fields (key/value pairs derived from calculationValue's own `${slot}_value_status`/`${slot}_status` fields)",
      closed_status_vocabulary: ["NOT_FOUND", "NOT_APPLICABLE", "OUTSIDE_CORPUS", "WITHHELD"],
      required_precondition: "extractNarrativeFields만 resolveSlotName(key)로 slotName을 얻은 뒤 slotToFactId.get(slotName)이 성공해야 렌더링됨 -- 즉 (a) Plan에 그 필드에 대응하는 slot이 존재하고 (b) 그 slot이 실제 fact_id를 가리켜야 함. 둘 중 하나라도 없으면 blockers 배열로만 빠지고 narrative에는 아무것도 렌더링되지 않음(조용히 누락, 텍스트 생성 안 됨).",
    },
    finding: {
      q18_has_issuance_amount_slot_in_plan: hasIssuanceAmountSlot,
      why_generic_path_cannot_express_this: "ISSUANCE_AMOUNT는 Owner 정책(Turn M6/M7)에 따라 이번 Turn에 VERIFIED Fact로 승격되지 않았고 Plan에도 slot을 추가하지 않았다(Section 4에서 의도적으로 제외). renderInformationLimitSentences 경로는 '이 필드에 대응하는 slot+fact가 존재하지만 그 값의 value_status가 NOT_FOUND/NOT_APPLICABLE/OUTSIDE_CORPUS/WITHHELD 중 하나'인 경우만 문장을 만든다. Q18의 경우는 그 4개 상태 중 하나가 아니라 'slot 자체가 애초에 존재하지 않는다'는 다른 종류의 상황이며, 이 경로는 slot이 없는 필드에 대해 아무 문장도 생성하지 않고 조용히 blockers로만 기록한다(사용자에게 보이는 텍스트 없음).",
      generalizes_beyond_q18: "이것은 Q18 전용 결함이 아니라, '이 프로젝트에 해당 개념의 Fact/slot 자체가 아직 없다'는 상황 전반에 적용되는 구조적 gap이다. 4-status 메커니즘은 '슬롯은 있는데 값이 특수 상태'인 경우만 다루고, '슬롯 자체가 없음'을 독자에게 알리는 5번째 generic 경로가 아직 없다.",
      other_generic_paths_considered_and_rejected: [
        {
          path: "sub_request_authority=STRUCTURED evaluation (MISSING status)",
          why_rejected: "Q18의 Plan은 sub_request_authority가 HEURISTIC이라 REQUEST_COMPLETENESS 자체가 NOT_IMPLEMENTED로 보고됨. 설령 STRUCTURED였더라도 MISSING 판정은 compositionWarnings/not_implemented_capabilities라는 내부 진단 필드로만 남고, narrative_text에 실제 문장으로 렌더링되지 않는다.",
        },
        {
          path: "renderProductLifecycleConclusion의 scope_note 기반 info-limit 문구",
          why_rejected: "이 경로는 authorization+launch Fact 쌍이 모두 존재할 때만 발동하는 특정 shape 탐지기이며 Q18의 shape(유상증자 결정->발행 완료)과 무관함. 억지로 재사용하면 그 자체가 또 다른 형태의 Q18 전용 우회가 됨.",
        },
        {
          path: "기존 ISSUANCE_COMPLETION_STATUS slot에 issuance_amount_status 키를 얹기",
          why_rejected: "ISSUANCE_COMPLETION_STATUS는 실제로 DISCLOSED/CONFIRMED 상태이므로, 여기에 발행총액 결측 상태를 얹으면 서로 다른 두 사실을 하나의 slot으로 합쳐 왜곡하게 됨 -- 금지됨(Q18 전용 우회이자 값 왜곡).",
        },
      ],
    },
    decision: "IMPLEMENTATION_GAP",
    action_taken_this_turn: "새 프레임워크나 Q18 전용 분기를 추가하지 않고 멈춤. Q18 답변은 기존 NARRATIVE_SOURCE_DISCLOSURE로 54,495주/40,350원을 그대로 노출하며(이미 동작 중, Turn M4부터), '발행총액' 자체에 대해서는 긍정도 부정도 하는 문장이 없는 현재 상태를 유지함 -- 이는 최소한 금지 사항(2,198,873,250원을 발행총액으로 단정, 기타자금 재명명, 계산결과를 VERIFIED Fact처럼 표시)을 위반하지 않는 안전한 상태이지만, Owner가 요구한 명시적 정보한계 문장은 아직 렌더링되지 않는다.",
    recommended_v021_backlog_item: "5번째 generic information-limit 경로 설계: '이 개념에 대응하는 slot/Fact가 Plan에 전혀 없음'을 감지해 일반적인 문구(예: '{필드}는 현재 구조화 자료에서 원문 직접 공시 항목으로 확인되지 않습니다')로 렌더링하는 메커니즘. Plan이 선언한 REQUIRED_BUT_UNAVAILABLE 필드 목록 같은 명시적 신호가 필요하며, 이는 Composer 공통 코드 변경이므로 별도 Turn에서 설계·계약 테스트와 함께 진행.",
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ decision: report.decision, q18_has_slot: hasIssuanceAmountSlot }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
