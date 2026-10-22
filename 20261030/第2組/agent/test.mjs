// 用法: node agent/test.mjs
// 獨立驗證:方案幾何/5% 面積不信任引擎自己的判定;並用旋轉建築與不同風向的合成資料驗證通用性。
import assert from 'node:assert/strict';
import { loadInputs, deriveOfficeRoom } from './data.mjs';
import { generateProposals } from './engine.mjs';
import { parseEpw, windModel } from './epw.mjs';

const base = loadInputs({ model: '01' });
const baseAll = loadInputs({ model: '01', comfort: false }); // 不篩選時段,用來對照組員 1 的全年統計

// ---------- 共用的獨立檢查 ----------
function checkProposals(inputs, proposals, label) {
  const walls = Object.fromEntries(inputs.building.walls.map((w) => [w.wall_id, w]));
  const room = deriveOfficeRoom(inputs.building);
  assert.ok(proposals.length >= 1, `${label}: 至少一組方案`);
  for (const p of proposals) {
    let legal = 0;
    const spansByWall = {};
    for (const w of p.windows) {
      const wall = walls[w.wall_id];
      assert.ok(wall.is_exterior, `${label}: 只能開在外牆`);
      const lo = w.s_center_m - w.occupied_width_m / 2;
      const hi = w.s_center_m + w.occupied_width_m / 2;
      assert.ok(wall.available_window_intervals.some((iv) => lo >= iv.s_start_m - 1e-6 && hi <= iv.s_end_m + 1e-6), `${label}: 窗超出可排窗區間`);
      const a = wall.location_line.start_xyz_m;
      const u = wall.location_line.s_axis_unit_xyz;
      assert.ok(Math.abs(w.position_mm.x - (a[0] + w.s_center_m * u[0]) * 1000) <= 1 && Math.abs(w.position_mm.y - (a[1] + w.s_center_m * u[1]) * 1000) <= 1, `${label}: 座標不在牆上`);
      assert.ok(w.sill_height_m + w.height_m <= wall.height_m);
      assert.match(w.mcp_windowType, /^M_Window-(Casement-Double|Double-Hung): /);
      legal += w.width_m * w.height_m * w.opening_ratio;
      (spansByWall[w.wall_id] ||= []).push([lo, hi]);
    }
    for (const spans of Object.values(spansByWall)) {
      spans.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] - spans[i - 1][1] >= 0.3 - 1e-6, `${label}: 窗間距不足`);
    }
    assert.ok(legal >= 0.05 * room.floor_area_m2, `${label}: ${p.proposal_id} 未達 5%`);
    assert.equal(p.requires_user_confirmation, true);
  }
}

// ---------- 1. EPW 解析:與組員 1 的 weather_analysis.json 一致 ----------
assert.ok(Math.abs(baseAll.wind.exposure_m_s(0) - 1.2507951128719552) < 1e-9, 'N 向風曝露應與 weather_analysis.json 相同');
assert.equal(base.wind.location.city, 'Tainan');

// ---------- 2. 模型 01 + 台南 ----------
const r1 = generateProposals(base);
assert.ok(Math.abs(r1.room.floor_area_m2 - 357.861) < 0.01, `辦公區面積 ${r1.room.floor_area_m2}`);
assert.ok(Math.abs(r1.room.core_room_check.derived_inner_area_m2 - r1.room.core_room_check.revit_room_area_m2) < 0.01);
checkProposals(base, r1.proposals, '模型01/台南');
// 避開服務核:北南窗的佔用範圍不得與核心筒 x 範圍(-4.18356 ~ 2.01644)重疊
const ns = r1.proposals.find((p) => p.scheme === 'N-S');
for (const w of ns.windows) {
  const x = w.position_mm.x / 1000;
  assert.ok(x + w.occupied_width_m / 2 <= -4.18356 + 1e-6 || x - w.occupied_width_m / 2 >= 2.01644 - 1e-6, '北南窗不應正對服務核');
  assert.equal(w.facing_core, false);
}

// ---------- 3. 合成 EPW:全年固定東風 → 東西對流應排第一 ----------
function fakeEpw(city, dir, spd) {
  const rows = [`LOCATION,${city},XXX,TWN,Custom,000000,25.0,121.5,8.0,10.0`, 'DATA PERIODS,1,1,Data,Sunday,1/ 1,12/31'];
  for (let m = 1; m <= 12; m++) for (let h = 0; h < 24; h++) {
    const f = Array(35).fill('0');
    f[0] = '2020'; f[1] = String(m); f[2] = '1'; f[3] = String(h + 1); f[6] = '25'; f[20] = String(dir); f[21] = String(spd);
    rows.push(f.join(','));
  }
  return rows.join('\n');
}
const eastWind = windModel(parseEpw(fakeEpw('Taipei', 90, 3)));
assert.equal(eastWind.location.city, 'Taipei');
const east = { ...base, wind: eastWind };
const r2 = generateProposals(east);
checkProposals(east, r2.proposals, '模型01/東風');
assert.equal(r2.proposals[0].scheme, 'E-W', '東風時東西對流應排第一');

// ---------- 4. 旋轉建築 30°(順時針) + 東風:應選方位 120°/300° 的相對牆 ----------
const th = (30 * Math.PI) / 180;
const rot = ([x, y, z = 0]) => [x * Math.cos(th) + y * Math.sin(th), -x * Math.sin(th) + y * Math.cos(th), z];
const rotatedBuilding = structuredClone(base.building);
for (const w of rotatedBuilding.walls) {
  w.location_line.start_xyz_m = rot(w.location_line.start_xyz_m);
  w.location_line.end_xyz_m = rot(w.location_line.end_xyz_m);
  w.location_line.s_axis_unit_xyz = rot(w.location_line.s_axis_unit_xyz);
  w.orientation.azimuth_deg = (w.orientation.azimuth_deg + 30) % 360;
  w.orientation.outward_normal_xyz = rot(w.orientation.outward_normal_xyz);
}
const rotated = { ...base, building: rotatedBuilding, wind: eastWind };
const r3 = generateProposals(rotated);
assert.ok(Math.abs(r3.room.floor_area_m2 - 357.861) < 0.01, `旋轉後辦公區面積應不變,實得 ${r3.room.floor_area_m2}`);
checkProposals(rotated, r3.proposals, '旋轉30°/東風');
const az = Object.fromEntries(rotatedBuilding.walls.map((w) => [w.wall_id, w.orientation.azimuth_deg]));
assert.deepEqual(r3.proposals[0].wall_ids.map((id) => az[id]).sort((a, b) => a - b), [120, 300], '應選 120°/300° 這對牆');

// ---------- 5. 開窗時段篩選:太冷的時數不納入 ----------
const cold = parseEpw(fakeEpw('Cold', 0, 3).replace(/,25,/g, ',10,'));
assert.throws(() => windModel(cold), /沒有可開窗的時數/, '全年 10°C 時預設不應有任何可開窗時數');
assert.equal(windModel(cold, null, null).hours, 288, 'comfort=null 應統計全部時數');
const mixed = parseEpw(fakeEpw('Mixed', 0, 3));
for (const h of mixed.hours) h.temp = h.month <= 2 || h.month === 12 ? 10 : 25; // 冬季 10°C、其餘 25°C
const m = windModel(mixed);
assert.equal(m.monthly_usable_hours[1], 0);
assert.equal(m.monthly_usable_hours[7], 15, '假資料每月 1 天:7 月應只有 8–22 時共 15 小時');
assert.ok(Math.abs(m.usable_fraction - (9 * 15 / 288)) < 1e-9);

// ---------- 6. 模型 02:服務核貼外牆,不可把窗開在 Core 房間的牆段 ----------
const m02 = loadInputs({ model: '02' });
const r02 = generateProposals(m02);
assert.ok(Math.abs(r02.room.floor_area_m2 - 419.076) < 0.01, `模型02 辦公區面積 ${r02.room.floor_area_m2}`);
checkProposals(m02, r02.proposals, '模型02/台南');
for (const p of r02.proposals) for (const w of p.windows) {
  const iv = m02.building.walls.find((x) => x.wall_id === w.wall_id).available_window_intervals.find((i) => w.s_center_m >= i.s_start_m && w.s_center_m <= i.s_end_m);
  assert.notEqual(iv.office_candidate, false, '窗不可開在 Core 房間的牆段');
}

// ---------- 7. 一次一個模型、固定給 3 個方案 ----------
assert.equal(r1.proposals.length, 3, '模型01 自動模式應給 3 個方案');
assert.equal(r02.proposals.length, 3, '模型02 自動模式應給 3 個方案');

console.log('通過:EPW 與組員 1 結果一致、辦公區面積、5% 檢核、避開服務核、東風與旋轉建築的通用性、模型 02、固定 3 個方案');
