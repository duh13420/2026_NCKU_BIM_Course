// Agent 可呼叫的工具:定義(JSON Schema)與實作。所有工具唯讀,不會建窗。
import path from 'node:path';
import { loadInputs, DEFAULTS, buildCatalog, deriveOfficeRoom } from './data.mjs';
import { generateProposals } from './engine.mjs';
import { DEFAULT_COMFORT } from './epw.mjs';
import { run } from './generate.mjs';

let lastResult = null;

const siteProps = {
  model: { type: 'string', description: "模型編號,預設 '01'" },
  epw_path: { type: 'string', description: '任意地點的 EPW 氣象檔路徑;省略則用專案內第一個 .epw' },
  months: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 12 }, description: '只用這些月份的風資料;省略 = 全年' },
  t_min_c: { type: 'number', description: '低於此氣溫(°C)視為太冷不開窗,預設 18' },
  t_max_c: { type: 'number', description: '高於此氣溫(°C)視為太熱不開窗,預設 30' },
  all_hours: { type: 'boolean', description: 'true = 不依氣溫與時段篩選,統計全部時數' },
};

export const toolDefinitions = [
  {
    name: 'get_site_summary',
    description: '取得建築與氣象摘要:氣象地點與常見風向、辦公區面積、各外牆方位/長度/風向分數/可排窗區間、服務核位置、可通風窗型與預設假設。',
    input_schema: { type: 'object', properties: siteProps, additionalProperties: false },
  },
  {
    name: 'generate_window_proposals',
    description: '依外牆方位與尺寸、服務核位置、所選地點的風資料,產生 1–3 組開窗方案(位置、尺寸、窗型、原因),並寫入 window_proposals_modelXX.json(XX = 模型編號)。只產生建議,不會修改 Revit。',
    input_schema: { type: 'object', properties: { ...siteProps, max_proposals: { type: 'integer', minimum: 1, maximum: 3 } }, additionalProperties: false },
  },
  {
    name: 'get_proposal',
    description: '取得最近一次產生的某組方案完整內容(含逐窗座標與檢核表)。',
    input_schema: { type: 'object', properties: { proposal_id: { type: 'string', description: '例如 P1' } }, required: ['proposal_id'], additionalProperties: false },
  },
];

const comfortOf = (a) => {
  if (a.all_hours) return false;
  if (a.t_min_c == null && a.t_max_c == null) return undefined;
  return { ...DEFAULT_COMFORT, ...(a.t_min_c != null && { t_min_c: a.t_min_c }), ...(a.t_max_c != null && { t_max_c: a.t_max_c }) };
};
const load = (a) => loadInputs({ model: a.model || '01', epw: a.epw_path || null, months: a.months || null, comfort: comfortOf(a) });

export function callTool(name, args = {}) {
  if (name === 'get_site_summary') {
    const inp = load(args);
    const room = deriveOfficeRoom(inp.building);
    return {
      weather: { location: inp.wind.location, period: inp.wind.period, open_window_filter: inp.wind.comfort, usable_hours: inp.wind.hours, usable_fraction: +inp.wind.usable_fraction.toFixed(3), monthly_usable_hours: inp.wind.monthly_usable_hours, mean_speed_m_s: +inp.wind.mean_speed_m_s.toFixed(2), prevailing: inp.wind.prevailing, epw_file: path.basename(inp.epwFile) },
      office_room: { floor_area_m2: room.floor_area_m2, basis: room.basis },
      required_legal_open_area_m2: +(DEFAULTS.legal_ratio * room.floor_area_m2).toFixed(2),
      service_cores: room.cores.map((c) => ({ core_id: c.core_id, box_m: c.box })),
      exterior_walls: inp.building.walls.filter((w) => w.is_exterior).map((w) => ({
        wall_id: w.wall_id, azimuth_deg: w.orientation.azimuth_deg, length_m: w.length_m, height_m: w.height_m,
        wind_score_0_1: +inp.wind.score(w.orientation.azimuth_deg).toFixed(3),
        free_intervals_s_m: (w.available_window_intervals || []).map((i) => [i.s_start_m, i.s_end_m]),
      })),
      ventilation_window_types: buildCatalog(inp).map((t) => `${t.mcp_windowType} (開啟比例 ${t.opening_ratio.toFixed(3)})`),
      defaults: DEFAULTS,
    };
  }
  if (name === 'generate_window_proposals') {
    const inp = load(args);
    lastResult = generateProposals(inp, { max_proposals: args.max_proposals });
    run({ model: args.model || '01', epw: args.epw_path || null, months: args.months || null, comfort: comfortOf(args), max_proposals: args.max_proposals });
    return lastResult.proposals.map((p) => ({
      proposal_id: p.proposal_id, scheme: p.scheme, score: p.score, window_count: p.window_count,
      family_type: p.family_type, per_wall: p.per_wall, reason: p.reason, checks: p.checks,
    }));
  }
  if (name === 'get_proposal') {
    const p = lastResult?.proposals.find((x) => x.proposal_id === args.proposal_id);
    return p || { error: '尚未產生方案或找不到此 proposal_id,請先呼叫 generate_window_proposals' };
  }
  return { error: `未知工具 ${name}` };
}
