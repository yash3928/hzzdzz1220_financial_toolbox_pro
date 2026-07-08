import { connectHousehold, saveHouseholdData, disconnectHousehold } from './firebase.js';

const APP_VERSION = '0.6.2';
const SCHEMA_VERSION = 2;
const STORAGE_KEY = 'hzzdzz-finance-local-cache-v1';
const LEGACY_STORAGE_KEYS = ['hzzdzz-finance-v05-local','couple-budget-v4-local','couple-budget-v3-local','couple-budget-v2-local'];
const SYNC_KEY = 'hzzdzz-finance-sync-v1';
const LEGACY_SYNC_KEYS = ['couple-budget-v3-sync','couple-budget-v2-sync'];
const DEFAULT_HOUSEHOLD_ID = 'hzzdzz_가계부';
const BUDGET_CATEGORIES = ['식비', '생필품', '의료', '비상금', '여행비', '경조사비', '육아'];
const ASSET_TYPES = ['은행', '현금', '연금', '청약', '코인', '기타'];
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });
const nowYear = new Date().getFullYear();

const defaultData = {
  entries: [],
  settings: { monthStartDay: 10 },
  monthlyBudgets: {},
  fixedExpenses: [],
  annualPlans: [],
  assets: [],
  investments: [],
  duty: {},
  logs: [],
  appMeta: { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION }
};

let state = mergeData(loadStoredJson([STORAGE_KEY, ...LEGACY_STORAGE_KEYS]));
let sync = normalizeSync(loadStoredJson([SYNC_KEY, ...LEGACY_SYNC_KEYS]));
localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
let remoteReady = false;
let syncingFromRemote = false;

function loadStoredJson(keys){
  for(const key of keys){
    const text = localStorage.getItem(key);
    if(text){ try{ return JSON.parse(text); }catch{} }
  }
  return null;
}

function normalizeSync(raw){
  if(!raw) return { householdId: DEFAULT_HOUSEHOLD_ID, configText: '' };
  const householdId = raw.householdId || raw.household || DEFAULT_HOUSEHOLD_ID;
  let configText = raw.configText || '';
  if(!configText && raw.config) configText = JSON.stringify(raw.config, null, 2);
  return { householdId, configText };
}
function hasUserData(data){
  return !!(data && (data.entries?.length || data.fixedExpenses?.length || data.annualPlans?.length || data.assets?.length || data.investments?.length || Object.keys(data.monthlyBudgets||{}).length || Object.keys(data.duty||{}).length));
}
function mergeData(raw){
  if(Array.isArray(raw)) raw = { entries: raw };
  const old = raw || {};
  const oldSettings = old.settings || {};
  const oldBudgets = oldSettings.budgets || {};
  const base = structuredClone(defaultData);
  const merged = {
    ...base,
    ...old,
    entries: Array.isArray(old.entries) ? old.entries : [],
    settings: { ...base.settings, ...oldSettings },
    monthlyBudgets: old.monthlyBudgets || { [periodKey(new Date(), oldSettings.monthStartDay || 10)]: { ...oldBudgets } },
    fixedExpenses: Array.isArray(old.fixedExpenses) ? old.fixedExpenses : [],
    annualPlans: Array.isArray(old.annualPlans) ? old.annualPlans : [],
    assets: Array.isArray(old.assets || oldSettings.assets) ? (old.assets || oldSettings.assets) : [],
    investments: Array.isArray(old.investments) ? old.investments : oldSettings.investment ? [{ id: uid(), type:'국내주식', name:'투자자산', principal:num(oldSettings.investment.principal), current:num(oldSettings.investment.current) }] : [],
    duty: old.duty || oldSettings.duty || {},
    logs: Array.isArray(old.logs) ? old.logs : [],
    appMeta: { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, ...(old.appMeta||{}) }
  };
  merged.appMeta.schemaVersion = SCHEMA_VERSION;
  merged.appMeta.appVersion = APP_VERSION;
  return merged;
}
function uid(){ return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function num(v){ return Number(v || 0); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function escapeHtml(v){ return String(v ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function periodKey(dateLike = new Date(), startDay = state.settings.monthStartDay){
  const d = new Date(dateLike); let y = d.getFullYear(); let m = d.getMonth() + 1;
  if(d.getDate() < startDay){ m -= 1; if(m === 0){ m = 12; y -= 1; } }
  return `${y}-${String(m).padStart(2,'0')}`;
}
function getPeriod(key = periodKey()){
  const [y, m] = key.split('-').map(Number);
  const start = new Date(y, m - 1, state.settings.monthStartDay);
  const end = new Date(y, m, state.settings.monthStartDay - 1);
  const iso = d => d.toISOString().slice(0,10);
  return { key, label: `${y}년 ${m}월`, startISO: iso(start), endISO: iso(end), start, end };
}
function currentPeriodEntries(){
  const p = getPeriod();
  return state.entries.filter(e => e.date >= p.startISO && e.date <= p.endISO);
}
function currentFixedExpenses(){ return state.fixedExpenses.filter(x => x.active !== false); }
function currentBudget(){ return { ...Object.fromEntries(BUDGET_CATEGORIES.map(c=>[c,0])), ...(state.monthlyBudgets[periodKey()] || {}) }; }
function budgetTotal(){ return Object.values(currentBudget()).reduce((a,b)=>a+num(b),0); }
function actualExpenses(entries = currentPeriodEntries()){
  return entries.filter(e=>e.type==='expense').reduce((a,e)=>a+num(e.amount),0) + currentFixedExpenses().reduce((a,e)=>a+num(e.amount),0);
}
function incomeTotal(entries = currentPeriodEntries()){ return entries.filter(e=>e.type==='income').reduce((a,e)=>a+num(e.amount),0); }
function categoryUsedMap(){
  const map = Object.fromEntries(BUDGET_CATEGORIES.map(c=>[c,0]));
  currentPeriodEntries().filter(e=>e.type==='expense').forEach(e => map[e.category] = num(map[e.category]) + num(e.amount));
  currentFixedExpenses().forEach(e => map[e.category] = num(map[e.category]) + num(e.amount));
  return map;
}
function investmentTotals(){
  const domestic = state.investments.filter(i=>i.type==='국내주식').reduce((a,i)=>a+num(i.current),0);
  const foreign = state.investments.filter(i=>i.type==='해외주식').reduce((a,i)=>a+num(i.current),0);
  const principal = state.investments.reduce((a,i)=>a+num(i.principal),0);
  const current = state.investments.reduce((a,i)=>a+num(i.current),0);
  const profit = current - principal;
  const rate = principal ? profit / principal * 100 : 0;
  return { domestic, foreign, principal, current, profit, rate };
}
function totalAssets(){ return state.assets.reduce((a,x)=>a+num(x.amount),0) + investmentTotals().current; }

function saveLocal(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function addLog(action, detail){
  state.logs = state.logs || [];
  state.logs.unshift({ id:uid(), action, detail, at:new Date().toISOString() });
  state.logs = state.logs.slice(0,200);
}
function scheduleRemoteSave(){
  state.appMeta = { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION };
  saveLocal();
  if(!remoteReady || syncingFromRemote) return;
  saveHouseholdData(state);
}

function renderAll(){
  fillSelects(); renderPeriod(); renderHome(); renderBudgets(); renderLists(); renderAssets(); renderInvestments(); renderAnalysis(); renderSettings(); saveLocal();
}
function renderPeriod(){
  const p = getPeriod();
  $('periodText').textContent = `${p.label} · ${p.startISO} ~ ${p.endISO}`;
  $('monthRuleText').textContent = `매월 ${state.settings.monthStartDay}일 시작`;
}
function renderHome(){
  const list = currentPeriodEntries();
  const income = incomeTotal(list);
  const exp = actualExpenses(list);
  const remain = budgetTotal() - exp;
  $('totalAssets').textContent = fmt.format(totalAssets());
  $('investmentAssets').textContent = fmt.format(investmentTotals().current);
  $('periodSavings').textContent = fmt.format(income - exp);
  $('budgetRemain').textContent = fmt.format(remain);
  $('budgetOverview').innerHTML = [
    ['월 공동예산', budgetTotal()], ['사용금액', exp], ['남은금액', remain], ['매월 고정지출', currentFixedExpenses().reduce((a,x)=>a+num(x.amount),0)]
  ].map(([k,v])=>`<div class="overview-card"><span>${k}</span><b>${fmt.format(v)}</b></div>`).join('');
  renderMonthlyChart(); renderHomeInsights();
}
function renderBudgets(){
  const used = categoryUsedMap(); const budget = currentBudget();
  $('budgetCards').innerHTML = BUDGET_CATEGORIES.map(cat => {
    const b = num(budget[cat]); const u = num(used[cat]); const remain = b-u;
    const pct = b ? Math.min(100, Math.round(u/b*100)) : 0;
    return `<div class="budget-card ${b && u>b ? 'over' : ''}"><div class="budget-top"><b>${cat}</b><span>${fmt.format(remain)} 남음</span></div><div class="progress"><i style="width:${pct}%"></i></div><div class="budget-meta">${fmt.format(u)} / ${fmt.format(b)} · ${b ? Math.round(u/b*100) : 0}%</div></div>`;
  }).join('');
}
function renderMonthlyChart(){
  const rows = [];
  for(let i=5;i>=0;i--){
    const d = new Date(); d.setMonth(d.getMonth()-i);
    const key = periodKey(d); const p = getPeriod(key);
    const used = state.entries.filter(e=>e.type==='expense' && e.date>=p.startISO && e.date<=p.endISO).reduce((a,e)=>a+num(e.amount),0) + currentFixedExpenses().reduce((a,e)=>a+num(e.amount),0);
    rows.push({ label: key.slice(5)+'월', used });
  }
  const max = Math.max(...rows.map(r=>r.used), 1);
  $('monthlyChart').innerHTML = rows.map(r=>`<div class="chart-col"><i style="height:${Math.max(4, r.used/max*100)}%"></i><span>${r.label}</span><em>${Math.round(r.used/10000)}만</em></div>`).join('');
}
function renderHomeInsights(){
  const msg = buildInsights().slice(0,4);
  $('homeInsights').innerHTML = msg.map(m=>`<div class="insight">${escapeHtml(m)}</div>`).join('');
}
function renderLists(){
  $('fixedList').innerHTML = state.fixedExpenses.length ? state.fixedExpenses.map((x,i)=>`<div class="list-item"><div><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.category)} · ${escapeHtml(x.memo||'매월 반영')}</span></div><strong>${fmt.format(x.amount)}</strong><button data-fixed-delete="${i}" type="button">삭제</button></div>`).join('') : '<div class="empty">매월 나가는 고정지출을 입력하세요.</div>';
  $('annualList').innerHTML = state.annualPlans.length ? state.annualPlans.map((x,i)=>`<div class="list-item"><div><b>${escapeHtml(x.year)}년 ${escapeHtml(x.month)}월 · ${escapeHtml(x.name)}</b><span>${escapeHtml(x.category)} · ${escapeHtml(x.memo||'연간 계획')}</span></div><strong>${fmt.format(x.amount)}</strong><button data-annual-delete="${i}" type="button">삭제</button></div>`).join('') : '<div class="empty">연간 계획 예산을 입력하세요.</div>';
}
function renderAssets(){
  const inv = investmentTotals();
  const computed = [
    { type:'국내주식', name:'투자관리 합계', amount:inv.domestic, readonly:true },
    { type:'해외주식', name:'투자관리 합계', amount:inv.foreign, readonly:true }
  ].filter(x=>x.amount>0);
  const list = [...state.assets, ...computed];
  $('assetList').innerHTML = list.length ? list.map((a,i)=>`<div class="asset-item"><b>${escapeHtml(a.name)}</b><b>${fmt.format(a.amount)}</b><span>${escapeHtml(a.type)}${a.readonly?' · 자동연동':''}</span>${a.readonly?'':`<button type="button" data-asset-delete="${i}">삭제</button>`}</div>`).join('') : '<div class="empty">자산을 입력하면 총자산이 자동 계산됩니다.</div>';
}
function renderInvestments(){
  const t = investmentTotals();
  $('investmentResult').innerHTML = `총 투자원금 <b>${fmt.format(t.principal)}</b><br>총 평가금액 <b>${fmt.format(t.current)}</b><br>총 손익 <b>${fmt.format(t.profit)}</b> · 총 수익률 <b>${t.rate.toFixed(1)}%</b>`;
  $('investmentSummary').innerHTML = `<div class="invest-kpis"><div><span>국내주식</span><b>${fmt.format(t.domestic)}</b></div><div><span>해외주식</span><b>${fmt.format(t.foreign)}</b></div><div><span>총 수익률</span><b>${t.rate.toFixed(1)}%</b></div></div>`;
  $('investmentList').innerHTML = state.investments.length ? state.investments.map((x,i)=>{
    const profit = num(x.current)-num(x.principal); const rate = num(x.principal)?profit/num(x.principal)*100:0;
    return `<div class="list-item"><div><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.type)} · 원금 ${fmt.format(x.principal)} · 평가 ${fmt.format(x.current)}</span></div><strong>${rate.toFixed(1)}%</strong><button data-invest-delete="${i}" type="button">삭제</button></div>`;
  }).join('') : '<div class="empty">투자 종목을 입력하면 개별/총 수익률이 표시됩니다.</div>';
}
function buildInsights(){
  const used = categoryUsedMap(); const budget = currentBudget(); const list = currentPeriodEntries();
  const income = incomeTotal(list); const exp = actualExpenses(list); const total = budgetTotal();
  const messages=[];
  if(total>0) messages.push(`이번 기간 공동예산은 ${fmt.format(total)} 중 ${fmt.format(exp)} 사용했고, 잔액은 ${fmt.format(total-exp)}입니다.`);
  const top = Object.entries(used).sort((a,b)=>b[1]-a[1])[0]; if(top && top[1]>0) messages.push(`가장 많이 사용한 공동예산 분류는 ${top[0]}이며 ${fmt.format(top[1])}입니다.`);
  BUDGET_CATEGORIES.forEach(cat=>{ const b=num(budget[cat]), u=num(used[cat]); if(b && u/b>=1) messages.push(`${cat} 예산을 초과했습니다.`); else if(b && u/b>=.8) messages.push(`${cat} 예산을 80% 이상 사용했습니다.`); });
  if(income>0) messages.push(`이번 기간 예상 저축액은 ${fmt.format(income-exp)}입니다.`);
  const it = investmentTotals(); if(it.principal>0) messages.push(`전체 투자 수익률은 ${it.rate.toFixed(1)}%입니다.`);
  if(!messages.length) messages.push('예산, 지출, 자산을 입력하면 홈에서 자동 요약이 표시됩니다.');
  return messages;
}
function renderAnalysis(){
  $('insights').innerHTML = buildInsights().map(m=>`<div class="insight">${escapeHtml(m)}</div>`).join('');
  const used = categoryUsedMap(); const budget = currentBudget();
  $('categoryStats').innerHTML = BUDGET_CATEGORIES.map(cat=>`<div class="category-row"><b>${cat}</b><strong>${fmt.format(used[cat])}</strong><span>예산 ${fmt.format(budget[cat])} · 남은금액 ${fmt.format(num(budget[cat])-num(used[cat]))}</span></div>`).join('');
}
function renderSettings(){
  $('monthStartDay').value = state.settings.monthStartDay;
  $('budgetMonth').value = periodKey();
  renderBudgetFields();
  const d = state.duty[nowYear] || {}; $('dutyYear').value = nowYear; $('weekdayRate').value = d.weekdayRate || ''; $('weekendRate').value = d.weekendRate || ''; $('holidayRate').value = d.holidayRate || '';
  renderDutyMonths(nowYear);
  $('householdId').value = sync.householdId || DEFAULT_HOUSEHOLD_ID; $('firebaseConfig').value = sync.configText || '';
}
function renderBudgetFields(){
  const key = $('budgetMonth').value || periodKey(); const b = { ...Object.fromEntries(BUDGET_CATEGORIES.map(c=>[c,0])), ...(state.monthlyBudgets[key]||{}) };
  $('monthlyBudgetFields').innerHTML = BUDGET_CATEGORIES.map(cat=>`<label>${cat}<input data-budget-cat="${cat}" type="number" inputmode="numeric" min="0" value="${num(b[cat])}" /></label>`).join('');
}
function renderDutyMonths(year){
  const d = state.duty[year] || {}; const months = d.months || {};
  $('dutyMonths').innerHTML = Array.from({length:12},(_,i)=>i+1).map(m=>`<div class="duty-row"><b>${m}월</b><input data-duty-month="${m}" data-duty-type="weekday" type="number" min="0" placeholder="평일" value="${months[m]?.weekday||''}"><input data-duty-month="${m}" data-duty-type="weekend" type="number" min="0" placeholder="주말" value="${months[m]?.weekend||''}"><input data-duty-month="${m}" data-duty-type="holiday" type="number" min="0" placeholder="공휴" value="${months[m]?.holiday||''}"></div>`).join('');
}
function fillSelects(){
  ['expenseCategory','fixedCategory','annualCategory'].forEach(id=>{ const el=$(id); if(el && el.options.length!==BUDGET_CATEGORIES.length) el.innerHTML=BUDGET_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join(''); });
  if($('monthStartDay').options.length<31) $('monthStartDay').innerHTML = Array.from({length:28},(_,i)=>`<option value="${i+1}">매월 ${i+1}일</option>`).join('');
  if($('annualMonth').options.length<12) $('annualMonth').innerHTML = Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('');
}

function dutyPay(owner, date){
  if(owner !== '다혜') return 0;
  const y = new Date(date).getFullYear(); const m = new Date(date).getMonth()+1; const d = state.duty[y] || {}; const row = d.months?.[m] || {};
  return num(row.weekday)*num(d.weekdayRate)+num(row.weekend)*num(d.weekendRate)+num(row.holiday)*num(d.holidayRate);
}

function bindEvents(){
  document.querySelectorAll('.bottom-nav button').forEach(btn=>btn.addEventListener('click',()=>{ document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.dataset.page===btn.dataset.target)); renderAll(); }));
  $('budgetToggle').addEventListener('click', ()=>$('budgetDetailPanel').classList.toggle('hidden'));
  $('expenseDate').value = todayISO(); $('salaryDate').value = todayISO(); $('annualYear').value = nowYear;
  $('expenseForm').addEventListener('submit', e=>{ e.preventDefault(); state.entries.push({ id:uid(), type:'expense', owner:$('expenseOwner').value, date:$('expenseDate').value, category:$('expenseCategory').value, amount:num($('expenseAmount').value), memo:$('expenseMemo').value, createdAt:Date.now() }); addLog('지출 입력', `${$('expenseCategory').value} ${fmt.format($('expenseAmount').value)}`); e.target.reset(); $('expenseDate').value=todayISO(); scheduleRemoteSave(); renderAll(); });
  $('salaryOwner').addEventListener('change', updateDutyBox); $('salaryDate').addEventListener('change', updateDutyBox);
  $('salaryForm').addEventListener('submit', e=>{ e.preventDefault(); const owner=$('salaryOwner').value, date=$('salaryDate').value; const extra=dutyPay(owner,date); const base=num($('salaryBase').value); state.entries.push({ id:uid(), type:'income', owner, date, category:'월급', amount:base+extra, memo: owner==='다혜' ? `월급+당직수당 ${fmt.format(extra)}` : '월급', createdAt:Date.now() }); addLog('월급 입력', `${owner} ${fmt.format(base+extra)}`); e.target.reset(); $('salaryDate').value=todayISO(); updateDutyBox(); scheduleRemoteSave(); renderAll(); });
  $('budgetMonth').addEventListener('change', renderBudgetFields);
  $('monthlyBudgetForm').addEventListener('submit', e=>{ e.preventDefault(); const key=$('budgetMonth').value; state.monthlyBudgets[key] = {}; document.querySelectorAll('[data-budget-cat]').forEach(inp=>state.monthlyBudgets[key][inp.dataset.budgetCat]=num(inp.value)); addLog('월별 예산 저장', key); scheduleRemoteSave(); renderAll(); });
  $('fixedForm').addEventListener('submit', e=>{ e.preventDefault(); state.fixedExpenses.push({ id:uid(), name:$('fixedName').value, category:$('fixedCategory').value, amount:num($('fixedAmount').value), memo:$('fixedMemo').value, active:true }); addLog('고정지출 추가', $('fixedName').value); e.target.reset(); scheduleRemoteSave(); renderAll(); });
  $('annualForm').addEventListener('submit', e=>{ e.preventDefault(); state.annualPlans.push({ id:uid(), year:num($('annualYear').value), month:num($('annualMonth').value), name:$('annualName').value, category:$('annualCategory').value, amount:num($('annualAmount').value), memo:$('annualMemo').value }); addLog('연간 계획 추가', $('annualName').value); e.target.reset(); $('annualYear').value=nowYear; scheduleRemoteSave(); renderAll(); });
  $('assetForm').addEventListener('submit', e=>{ e.preventDefault(); state.assets.push({ id:uid(), type:$('assetType').value, name:$('assetName').value, amount:num($('assetAmount').value) }); addLog('자산 추가', $('assetName').value); e.target.reset(); scheduleRemoteSave(); renderAll(); });
  $('investmentForm').addEventListener('submit', e=>{ e.preventDefault(); state.investments.push({ id:uid(), type:$('investType').value, name:$('investName').value, principal:num($('investPrincipal').value), current:num($('investCurrent').value) }); addLog('투자 추가', $('investName').value); e.target.reset(); scheduleRemoteSave(); renderAll(); });
  $('settingsForm').addEventListener('submit', e=>{ e.preventDefault(); state.settings.monthStartDay = num($('monthStartDay').value); scheduleRemoteSave(); renderAll(); });
  $('dutyYear').addEventListener('change', e=>renderDutyMonths(num(e.target.value)));
  $('dutyForm').addEventListener('submit', e=>{ e.preventDefault(); const y=num($('dutyYear').value); const months={}; document.querySelectorAll('[data-duty-month]').forEach(inp=>{ const m=inp.dataset.dutyMonth; months[m]=months[m]||{}; months[m][inp.dataset.dutyType]=num(inp.value); }); state.duty[y] = { weekdayRate:num($('weekdayRate').value), weekendRate:num($('weekendRate').value), holidayRate:num($('holidayRate').value), months }; scheduleRemoteSave(); renderAll(); });
  document.addEventListener('click', e=>{ const t=e.target; if(t.dataset.fixedDelete){ state.fixedExpenses.splice(num(t.dataset.fixedDelete),1); scheduleRemoteSave(); renderAll(); } if(t.dataset.annualDelete){ state.annualPlans.splice(num(t.dataset.annualDelete),1); scheduleRemoteSave(); renderAll(); } if(t.dataset.assetDelete){ state.assets.splice(num(t.dataset.assetDelete),1); scheduleRemoteSave(); renderAll(); } if(t.dataset.investDelete){ state.investments.splice(num(t.dataset.investDelete),1); scheduleRemoteSave(); renderAll(); } });
  $('backupBtn').addEventListener('click', backupData);
  $('restoreFile').addEventListener('change', restoreData);
  $('syncForm').addEventListener('submit', async e=>{ e.preventDefault(); sync = { householdId:$('householdId').value.trim() || DEFAULT_HOUSEHOLD_ID, configText:$('firebaseConfig').value.trim() }; localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); await connectFirebase(); });
  $('localModeBtn').addEventListener('click',()=>{ disconnectHousehold(); localStorage.removeItem(SYNC_KEY); sync={householdId:DEFAULT_HOUSEHOLD_ID,configText:''}; location.reload(); });
  $('resetBtn').addEventListener('click',()=>{ if(confirm('현재 기기의 로컬 데이터를 초기화할까요? 공동 동기화 데이터는 삭제하지 않습니다.')){ localStorage.removeItem(STORAGE_KEY); location.reload(); } });
}
function updateDutyBox(){
  const owner=$('salaryOwner').value, date=$('salaryDate').value || todayISO(), extra=dutyPay(owner,date);
  $('dahyeDutyBox').classList.toggle('hidden', owner!=='다혜');
  $('dahyeDutyBox').innerHTML = owner==='다혜' ? `해당 월 당직수당 예상: <b>${fmt.format(extra)}</b>` : '';
}

function backupData(){
  const backup = { exportedAt:new Date().toISOString(), appVersion:APP_VERSION, schemaVersion:SCHEMA_VERSION, householdId:sync.householdId, data:state };
  const blob = new Blob([JSON.stringify(backup,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hzzdzz-finance-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
function restoreData(e){
  const file = e.target.files?.[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      const restored = parsed.data || parsed;
      if(!confirm('백업 파일의 데이터로 복원할까요? 현재 Firebase 데이터도 복원 데이터로 갱신됩니다.')) return;
      state = mergeData(restored);
      addLog('데이터 복원', file.name);
      scheduleRemoteSave();
      renderAll();
      alert('복원이 완료되었습니다.');
    }catch(err){ alert('복원 파일을 확인해주세요: '+err.message); }
    e.target.value = '';
  };
  reader.readAsText(file);
}
async function connectFirebase(){
  connectHousehold({
    configText: sync.configText,
    householdId: sync.householdId || DEFAULT_HOUSEHOLD_ID,
    onStatus: text => { $('syncStatus').textContent = text; $('syncStatus').classList.toggle('on', text==='공동 동기화'); },
    onRemoteData: data => {
      syncingFromRemote = true;
      state = mergeData(data);
      remoteReady = true;
      renderAll();
      syncingFromRemote = false;
    },
    onMissingData: () => {
      remoteReady = true;
      const initial = hasUserData(state) ? state : mergeData(null);
      return initial;
    },
    onError: err => { $('syncStatus').textContent='동기화 오류'; alert('Firebase 연결 오류: '+err.message); }
  });
}

bindEvents(); fillSelects(); updateDutyBox(); renderAll(); if(sync.configText) connectFirebase();
