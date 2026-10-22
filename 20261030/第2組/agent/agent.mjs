// 用法: ANTHROPIC_API_KEY=... node agent/agent.mjs "請幫我推薦開窗方案"
// LLM Agent:以 Claude tool use 呼叫 tools.mjs,對使用者說明推薦方案。只提出建議,執行建窗須由組員 4 的流程在使用者確認後進行。
import { toolDefinitions, callTool } from './tools.mjs';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SYSTEM = `你是 Revit 通風開窗設計 Agent,服務台灣各地的商辦標準層。氣象地點由使用者提供的 EPW 檔決定(epw_path),未指定時才用專案預設檔,並要明講用的是哪個地點。
工作流程:先呼叫 get_site_summary 了解現況,再呼叫 generate_window_proposals 取得方案,最後向使用者說明 1–3 組推薦。
規則:
- 只能依工具回傳的數據說明,不得自行編造面積、座標或法規條文。
- 說明每組方案的位置(哪一面牆、幾扇)、窗型與尺寸、推薦原因,並明講 assumption:法定有效通風面積為 PoC 暫算、辦公區面積由牆幾何推算、窗台 0.9 m、氣象期間(預設全年)。
- 你沒有建窗權限。方案必須經使用者明確確認後,才由 Revit MCP 流程執行;不要宣稱已建窗。
- 一次只處理一個模型(model 01 或 02),使用者沒說明時先問是哪一個。
- 本專案只比較自然通風,不討論採光、日射或風險分數。`;

async function call(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, tools: toolDefinitions, messages }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function ask(userText, maxTurns = 8) {
  const messages = [{ role: 'user', content: userText }];
  for (let i = 0; i < maxTurns; i++) {
    const resp = await call(messages);
    messages.push({ role: 'assistant', content: resp.content });
    if (resp.stop_reason !== 'tool_use') return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const results = resp.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(callTool(b.name, b.input)) }));
    messages.push({ role: 'user', content: results });
  }
  throw new Error('超過最大工具呼叫輪數');
}

if (process.argv[1]?.endsWith('agent.mjs')) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('請先設定環境變數 ANTHROPIC_API_KEY。沒有金鑰時可直接用: node agent/generate.mjs');
    process.exit(1);
  }
  ask(process.argv[2] || '請幫我推薦這個標準層的開窗方案。').then(console.log, (e) => { console.error(e.message); process.exit(1); });
}
