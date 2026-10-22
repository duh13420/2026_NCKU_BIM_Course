// 用法: node agent/generate.mjs [--model 01|02] [--epw 氣象檔.epw] [--months 6,7,8] [--tmin 18] [--tmax 30] [--hours 8,22] [--all-hours true] [--out 輸出.json]
// 讀取建築 JSON 與任意地點的 EPW,產生 window_proposals_model01.json / model02.json(不需 API key,不會修改 Revit)。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DEFAULTS, loadInputs } from './data.mjs';
import { generateProposals } from './engine.mjs';

export const defaultOut = (model) => path.join(ROOT, `window_proposals_model${model}.json`);

export function run({ model = '01', epw = null, months = null, comfort, out = defaultOut(model), schemes, max_proposals } = {}) {
  const inputs = loadInputs({ model, epw, months, comfort });
  const result = generateProposals(inputs, { schemes, max_proposals });
  const { cores, ...roomPublic } = result.room;
  const doc = {
    schema_version: '1.1',
    generated_for_model: `model_${model}`,
    status: 'proposed_pending_user_confirmation',
    scope: '只比較自然通風;不含採光、日射與風險分數',
    weather: { ...result.wind, epw_file: path.basename(inputs.epwFile) },
    units: { length: 'm', position_mm: 'mm (MCP locationX/Y)', area: 'm2', flow: 'm3/h' },
    coordinate_note: 'position_mm 為 Revit 內部座標換算成 mm;s_center_m 為沿牆 location line 自 start 起算的距離;方位為真北順時針',
    assumptions: {
      ...DEFAULTS,
      office_room: roomPublic,
      service_cores: cores.map((c) => ({ core_id: c.core_id, wall_ids: c.wall_ids, box_m: c.box, footprint_m2: +c.footprint_m2.toFixed(3) })),
      notes: [
        '辦公區面積:有 Revit 辦公 Room 就用 Room,否則由牆幾何推算',
        '法定有效通風面積為 PoC 暫算(寬×高×開啟比例),須由建築師或門窗廠覆核',
        'MCP create_window 無法指定寬高/窗台,須用完整 family:type 名稱建窗,建窗後回讀並修正 Sill Height',
      ],
    },
    proposals: result.proposals,
    rejected_summary: { count: result.rejected_count, sample: result.rejected_sample },
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2), 'utf8');
  return { doc, out };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  let comfort;
  if (a['all-hours'] === 'true') comfort = false;
  else if (a.tmin || a.tmax || a.hours) {
    const [from, to] = (a.hours || '8,22').split(',').map(Number);
    comfort = { t_min_c: +(a.tmin ?? 18), t_max_c: +(a.tmax ?? 30), hour_from: from, hour_to: to };
  }
  return { model: a.model, epw: a.epw, out: a.out && path.resolve(a.out), months: a.months ? a.months.split(',').map(Number) : null, comfort };
}

if (process.argv[1]?.endsWith('generate.mjs')) {
  const args = Object.fromEntries(Object.entries(parseArgs(process.argv.slice(2))).filter(([, v]) => v != null));
  if (args.model && !['01', '02'].includes(args.model)) throw new Error(`--model 只能是 01 或 02(一次只處理一個模型),收到 ${args.model}`);
  const model = args.model || '01';
  report(run({ ...args, model }), model);
}

function report({ doc, out }, model) {
  console.log(`
=== 模型 ${model} ===`);
  const r = doc.assumptions.office_room;
  const cf = doc.weather.comfort;
  console.log(`${doc.weather.location.city} (${doc.weather.period};${cf ? `僅統計 ${cf.t_min_c}–${cf.t_max_c}°C、${cf.hour_from}–${cf.hour_to} 時,佔 ${(doc.weather.usable_fraction * 100).toFixed(0)}%` : '不篩選時段'}),常見風向 ${doc.weather.prevailing.join('/')};辦公區 ${r.floor_area_m2} m²,5% = ${(r.floor_area_m2 * 0.05).toFixed(2)} m²`);
  for (const p of doc.proposals) console.log(`#${p.rank} ${p.scheme} score=${p.score} ${p.window_count} 扇 ${p.family_type}\n   ${p.reason}`);
  if (!doc.proposals.length) console.log('沒有任何方案通過 5% 檢核');
  console.log(`已寫入 ${out}`);
}
