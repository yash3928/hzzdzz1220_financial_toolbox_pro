import { connectHousehold, saveHouseholdData, disconnectHousehold } from './firebase.js';

const APP_VERSION = '0.7.3';
const SCHEMA_VERSION = 3;
const STORAGE_KEY = 'hzzdzz-finance-local-cache-v1';
const LEGACY_STORAGE_KEYS = ['hzzdzz-finance-v05-local','couple-budget-v4-local','couple-budget-v3-local','couple-budget-v2-local'];
const SYNC_KEY = 'hzzdzz-finance-sync-v1';
const LEGACY_SYNC_KEYS = ['couple-budget-v3-sync','couple-budget-v2-sync'];
const DEFAULT_HOUSEHOLD_ID = 'hzzdzz_가계부';
const MONTHLY_CATEGORIES = ['식비'];
const ANNUAL_CATEGORIES = ['생필품','비상금','쇼핑비','부모님','경조사비','육아'];
const EXPENSE_CATEGORIES = [...MONTHLY_CATEGORIES, ...ANNUAL_CATEGORIES];
const FIXED_CATEGORIES = ['보험료','고정현금','부모님 저축','대출 이자','관리비','통신비','기타'];
const ASSET_TYPES = ['은행', '현금', '연금', '청약', '코인', '여행비', '기타'];
const DEFAULT_DAHYE_DUTY = {
  basePay: 2700000,
  weekdayRate: 77330,
  holidayRate: 284470,
  sundayRate: 163640,
  monThuAssistRate: 10000,
  friAssistRate: 20000,
  vehicleSupport: 0,
  otherAllowance: 0,
  pensionRate: 4.75,
  healthRate: 3.595,
  careRate: 13.14,
  employmentRate: 0.9,
  incomeTax: 58750,
  localTaxRate: 10
};
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });
const nowYear = new Date().getFullYear();

const defaultData = {
  entries: [],
  settings: { monthStartDay: 10 },
  monthlyBudgets: {},
  annualBudgets: {},
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
function structuredCloneSafe(obj){ return JSON.parse(JSON.stringify(obj)); }
function mergeData(raw){
  if(Array.isArray(raw)) raw = { entries: raw };
  const old = raw || {};
  const oldSettings = old.settings || {};
  const base = structuredCloneSafe(defaultData);
  const entries = Array.isArray(old.entries) ? old.entries.map(e => ({
    ...e,
    payer: e.payer || e.owner || '진혁',
    category: normalizeCategory(e.category || '식비'),
    type: e.type || 'expense'
  })) : [];
  const annualBudgets = old.annualBudgets || {};
  if(old.annualPlans && !Object.keys(annualBudgets).length){
    old.annualPlans.forEach(p => {
      const y = p.year || nowYear;
      annualBudgets[y] = annualBudgets[y] || {};
      annualBudgets[y][normalizeCategory(p.category || p.name)] = num(annualBudgets[y][normalizeCategory(p.category || p.name)]) + num(p.amount);
    });
  }
  const oldBudget = old.monthlyBudgets || (oldSettings.budgets ? { [periodKey(new Date(), oldSettings.monthStartDay || 10)]: { ...oldSettings.budgets } } : {});
  return {
    ...base,
    ...old,
    entries,
    settings: { ...base.settings, ...oldSettings },
    monthlyBudgets: oldBudget,
    annualBudgets,
    fixedExpenses: Array.isArray(old.fixedExpenses) ? old.fixedExpenses : [],
    annualPlans: Array.isArray(old.annualPlans) ? old.annualPlans : [],
    assets: Array.isArray(old.assets || oldSettings.assets) ? (old.assets || oldSettings.assets) : [],
    investments: Array.isArray(old.investments) ? old.investments : oldSettings.investment ? [{ id: uid(), type:'국내주식', name:'투자자산', principal:num(oldSettings.investment.principal), current:num(oldSettings.investment.current) }] : [],
    duty: old.duty || oldSettings.duty || {},
    logs: Array.isArray(old.logs) ? old.logs : [],
    appMeta: { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, ...(old.appMeta||{}) }
  };
}
function normalizeCategory(cat){
  if(cat === '경조사') return '경조사비';
  if(cat === '쇼핑') return '쇼핑비';
  if(cat === '의료') return '비상금';
  return cat;
}
function uid(){ return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function num(v){ return Number(v || 0); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function escapeHtml(v){ return String(v ?? '').replace(/[&<>\"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function periodKey(dateLike = new Date(), startDay = state.settings.monthStartDay){
  const d = new Date(dateLike); let y = d.getFullYear(); let m = d.getMonth() + 1;
  if(d.getDate() < startDay){ m -= 1; if(m === 0){ m = 12; y -= 1; } }
  return `${y}-${String(m).padStart(2,'0')}`;
}
function addMonthsKey(key, delta){
  const [y,m] = key.split('-').map(Number);
  const d = new Date(y, m-1+delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function getPeriod(key = periodKey()){
  const [y, m] = key.split('-').map(Number);
  const start = new Date(y, m - 1, state.settings.monthStartDay);
  const end = new Date(y, m, state.settings.monthStartDay - 1);
  const iso = d => d.toISOString().slice(0,10);
  return { key, label: `${y}년 ${m}월`, year:y, month:m, startISO: iso(start), endISO: iso(end), start, end };
}
function entriesInPeriod(key = periodKey()){
  const p = getPeriod(key);
  return state.entries.filter(e => e.date >= p.startISO && e.date <= p.endISO);
}
function currentPeriodEntries(){ return entriesInPeriod(periodKey()); }
function currentFixedExpenses(){ return state.fixedExpenses.filter(x => x.active !== false); }
function monthlyBudget(key = periodKey()){ return { 식비: 0, ...(state.monthlyBudgets[key] || {}) }; }
function annualBudget(year = getPeriod().year){ return { ...Object.fromEntries(ANNUAL_CATEGORIES.map(c=>[c,0])), ...(state.annualBudgets[year] || {}) }; }
function periodExpenses(key = periodKey(), category = null){
  return entriesInPeriod(key).filter(e=>e.type==='expense' && (!category || e.category === category)).reduce((a,e)=>a+num(e.amount),0);
}
function yearExpenses(year, category = null){
  return state.entries.filter(e=>e.type==='expense' && new Date(e.date).getFullYear()===Number(year) && (!category || e.category===category)).reduce((a,e)=>a+num(e.amount),0);
}
function incomeByOwner(owner, list = currentPeriodEntries()){ return list.filter(e=>e.type==='income' && e.owner===owner).reduce((a,e)=>a+num(e.amount),0); }
function incomeTotal(list = currentPeriodEntries()){ return list.filter(e=>e.type==='income').reduce((a,e)=>a+num(e.amount),0); }
function fixedTotal(){ return currentFixedExpenses().reduce((a,e)=>a+num(e.amount),0); }
function currentFoodBudget(){
  const key = periodKey();
  const base = num(monthlyBudget(key).식비);
  const prev = addMonthsKey(key, -1);
  const prevBudget = num(monthlyBudget(prev).식비);
  const prevSpent = periodExpenses(prev, '식비');
  const prevDiff = prevBudget ? prevBudget - prevSpent : 0;
  return { base, prevDiff, adjusted: Math.max(0, base + Math.min(0, prevDiff)) };
}
function jaturiBalance(){
  const current = periodKey();
  return Object.keys(state.monthlyBudgets || {}).filter(k=>k < current).reduce((sum,k)=>{
    const b = num(monthlyBudget(k).식비);
    if(!b) return sum;
    return sum + (b - periodExpenses(k, '식비'));
  },0);
}
function investmentTotals(){
  const domestic = state.investments.filter(i=>i.type==='국내주식').reduce((a,i)=>a+num(i.current),0);
  const foreign = state.investments.filter(i=>i.type==='해외주식').reduce((a,i)=>a+num(i.current),0);
  const cma = state.investments.filter(i=>i.type==='CMA').reduce((a,i)=>a+num(i.current),0);
  const principal = state.investments.reduce((a,i)=>a+num(i.principal),0);
  const current = state.investments.reduce((a,i)=>a+num(i.current),0);
  const profit = current - principal;
  const rate = principal ? profit / principal * 100 : 0;
  return { domestic, foreign, cma, principal, current, profit, rate };
}
function totalAssets(){ return state.assets.reduce((a,x)=>a+num(x.amount),0) + investmentTotals().current; }
function saveLocal(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function addLog(action, detail){ state.logs.unshift({ id:uid(), action, detail, at:new Date().toISOString() }); state.logs = state.logs.slice(0,200); }
function scheduleRemoteSave(){
  state.appMeta = { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION };
  saveLocal();
  if(!remoteReady || syncingFromRemote) return;
  saveHouseholdData(state);
}
function hasUserData(data){ return !!(data && (data.entries?.length || data.fixedExpenses?.length || data.assets?.length || data.investments?.length || Object.keys(data.monthlyBudgets||{}).length || Object.keys(data.annualBudgets||{}).length)); }

function renderAll(){ fillSelects(); renderPeriod(); renderHome(); renderExpenseHistory(); renderMonthlyExpenses(); renderBudgets(); renderLists(); renderAssets(); renderInvestments(); renderSettings(); saveLocal(); }
function renderPeriod(){
  const p = getPeriod();
  $('periodText').textContent = `${p.label} · ${p.startISO} ~ ${p.endISO}`;
  $('dashboardTitle').textContent = `${p.label} 예산·정산 요약`;
}
function assetTypeSummary(){
  const inv = investmentTotals();
  const rows = {};
  state.assets.forEach(a => { rows[a.type] = num(rows[a.type]) + num(a.amount); });
  rows['국내주식'] = num(rows['국내주식']) + inv.domestic;
  rows['해외주식'] = num(rows['해외주식']) + inv.foreign;
  rows['CMA'] = num(rows['CMA']) + inv.cma;
  return rows;
}
function renderHomeAssetSummary(){
  const rows = assetTypeSummary();
  const order = ['은행','현금','CMA','국내주식','해외주식','연금','청약','코인','여행비','기타'];
  const total = totalAssets();
  const body = order.filter(k => num(rows[k]) > 0).map(k => `<tr><th>${k}</th><td>${fmt.format(rows[k])}</td></tr>`).join('');
  $('homeAssetTable').innerHTML = `<tbody><tr class="emphasis"><th>총 자산</th><td>${fmt.format(total)}</td></tr>${body || '<tr><td class="empty-cell" colspan="2">자산을 입력하면 이곳에 한눈에 표시됩니다.</td></tr>'}</tbody>`;
}
function periodExpenseRows(key = periodKey()){
  return entriesInPeriod(key).filter(e => e.type === 'expense').sort((a,b)=>String(a.date).localeCompare(String(b.date)) || (a.createdAt||0)-(b.createdAt||0));
}
function settlementForRows(expenses){
  const total = expenses.reduce((a,e)=>a+num(e.amount),0);
  const jin = expenses.filter(e=>e.payer==='진혁').reduce((a,e)=>a+num(e.amount),0);
  const dahye = expenses.filter(e=>e.payer==='다혜').reduce((a,e)=>a+num(e.amount),0);
  const half = total / 2;
  const diff = Math.round((jin - dahye) / 2);
  let result = '정산할 내역이 없습니다.';
  if(total > 0){
    if(diff > 0) result = `다혜 → 진혁 ${fmt.format(diff)} 송금`;
    else if(diff < 0) result = `진혁 → 다혜 ${fmt.format(Math.abs(diff))} 송금`;
    else result = '정산금액 없음';
  }
  return { total, jin, dahye, half, result };
}
function renderMonthlyExpenses(){
  const p = getPeriod();
  const rows = periodExpenseRows(p.key);
  if($('monthlyExpenseTitle')) $('monthlyExpenseTitle').textContent = `${p.label} 지출 내역`;
  if(!rows.length){
    $('monthlyExpenseTable').innerHTML = `<tbody><tr><td class="empty-cell">이번 기간 지출내역이 없습니다.</td></tr></tbody>`;
  } else {
    let running = 0;
    $('monthlyExpenseTable').innerHTML = `<thead><tr><th>순번</th><th>날짜</th><th>결제자</th><th>분류</th><th>내용</th><th>금액</th><th>누계</th><th>관리</th></tr></thead><tbody>` + rows.map((e,i)=>{
      running += num(e.amount);
      return `<tr><td>${i+1}</td><td>${e.date}</td><td>${escapeHtml(e.payer||e.owner)}</td><td>${escapeHtml(e.category)}</td><td>${escapeHtml(e.memo)}</td><td>${fmt.format(e.amount)}</td><td>${fmt.format(running)}</td><td class="actions"><button data-exp-edit="${e.id}" type="button">수정</button><button data-exp-delete="${e.id}" type="button">삭제</button></td></tr>`;
    }).join('') + `</tbody>`;
  }
  const st = settlementForRows(rows);
  if($('monthlySettleTotal')){
    $('monthlySettleTotal').textContent = fmt.format(st.total);
    $('monthlySettleJin').textContent = fmt.format(st.jin);
    $('monthlySettleDahye').textContent = fmt.format(st.dahye);
    $('monthlySettleHalf').textContent = fmt.format(st.half);
    $('monthlySettleResult').textContent = st.result;
  }
}

function renderHome(){
  renderHomeAssetSummary();
  const list = currentPeriodEntries();
  const jin = incomeByOwner('진혁', list), dahye = incomeByOwner('다혜', list), income = jin + dahye;
  const fixed = fixedTotal();
  const food = currentFoodBudget();
  const periodExp = periodExpenses(periodKey());
  const surplus = income - fixed - food.adjusted;
  $('incomeJin').textContent = fmt.format(jin); $('incomeDahye').textContent = fmt.format(dahye); $('incomeTotal').textContent = fmt.format(income); $('fixedTotal').textContent = fmt.format(fixed);
  $('foodBudgetCell').textContent = fmt.format(food.adjusted); $('expenseTotalCell').textContent = fmt.format(periodExp); $('surplusCell').textContent = fmt.format(surplus); $('jaturiCell').textContent = fmt.format(jaturiBalance());
  renderBudgetStatus(); renderSettlement(); renderHomeInsights();
}
function renderBudgetStatus(){
  const p = getPeriod(); const year = p.year; const annual = annualBudget(year); const food = currentFoodBudget(); const foodSpent = periodExpenses(periodKey(), '식비');
  const rows = [];
  rows.push({name:'식비', type:'월', budget:food.adjusted, spent:foodSpent, remain:food.adjusted-foodSpent});
  ANNUAL_CATEGORIES.forEach(cat=>{ const b=num(annual[cat]); const s=yearExpenses(year, cat); rows.push({name:cat, type:'연', budget:b, spent:s, remain:b-s}); });
  $('budgetStatusTable').innerHTML = `<thead><tr><th>분류</th><th>구분</th><th>예산</th><th>지출액</th><th>잔여액</th></tr></thead><tbody>` + rows.map(r=>`<tr class="${r.remain<0?'over':''}"><th>${r.name}</th><td>${r.type}</td><td>${fmt.format(r.budget)}</td><td>${fmt.format(r.spent)}</td><td>${fmt.format(r.remain)}</td></tr>`).join('') + `</tbody>`;
}
function renderSettlement(){
  const st = settlementForRows(periodExpenseRows(periodKey()));
  $('settleTotal').textContent = fmt.format(st.total); $('settleJin').textContent = fmt.format(st.jin); $('settleDahye').textContent = fmt.format(st.dahye); $('settleHalf').textContent = fmt.format(st.half); $('settleResult').textContent = st.result;
}
function renderHomeInsights(){
  const msgs = [];
  const food = currentFoodBudget(); const foodSpent = periodExpenses(periodKey(), '식비'); const foodRemain = food.adjusted - foodSpent;
  if(food.base) msgs.push(foodRemain>=0 ? `식비는 ${fmt.format(foodRemain)} 남았습니다. 남으면 자투리 통장으로 이동됩니다.` : `식비가 ${fmt.format(Math.abs(foodRemain))} 초과되었습니다. 다음 달 예산 차감 대상입니다.`);
  const settlement = $('settleResult')?.textContent || '';
  if(settlement && settlement !== '정산할 내역이 없습니다.') msgs.push(`이번 기간 정산 결과: ${settlement}`);
  const fixed = fixedTotal(); if(fixed) msgs.push(`매월 고정지출은 ${fmt.format(fixed)}입니다.`);
  const it = investmentTotals(); if(it.principal) msgs.push(`투자 총 수익률은 ${it.rate.toFixed(1)}%입니다.`);
  if(!msgs.length) msgs.push('월급, 예산, 지출내역을 입력하면 엑셀처럼 요약표가 자동으로 채워집니다.');
  $('homeInsights').innerHTML = msgs.slice(0,4).map(m=>`<div class="insight">${escapeHtml(m)}</div>`).join('');
}
function renderExpenseHistory(){
  const rows = currentPeriodEntries().filter(e=>e.type==='expense').sort((a,b)=>String(b.date).localeCompare(String(a.date)) || (b.createdAt||0)-(a.createdAt||0));
  if(!rows.length){ $('expenseHistoryTable').innerHTML = `<tbody><tr><td class="empty-cell">지출내역을 입력하면 정산표에 자동 반영됩니다.</td></tr></tbody>`; return; }
  $('expenseHistoryTable').innerHTML = `<thead><tr><th>날짜</th><th>결제자</th><th>분류</th><th>내용</th><th>금액</th><th>관리</th></tr></thead><tbody>` + rows.map(e=>`<tr><td>${e.date}</td><td>${escapeHtml(e.payer||e.owner)}</td><td>${escapeHtml(e.category)}</td><td>${escapeHtml(e.memo)}</td><td>${fmt.format(e.amount)}</td><td class="actions"><button data-exp-edit="${e.id}" type="button">수정</button><button data-exp-delete="${e.id}" type="button">삭제</button></td></tr>`).join('') + `</tbody>`;
}
function renderBudgets(){
  $('budgetMonth').value = periodKey();
  $('foodBudgetInput').value = num(monthlyBudget(periodKey()).식비) || '';
  $('annualBudgetYear').value = getPeriod().year;
  renderAnnualBudgetFields();
}
function renderAnnualBudgetFields(){
  const year = num($('annualBudgetYear').value) || getPeriod().year;
  const b = annualBudget(year);
  $('annualBudgetFields').innerHTML = ANNUAL_CATEGORIES.map(cat=>`<label>${cat}<input data-annual-budget-cat="${cat}" type="number" inputmode="numeric" min="0" value="${num(b[cat])||''}" /></label>`).join('');
}
function renderLists(){
  $('fixedList').innerHTML = state.fixedExpenses.length ? state.fixedExpenses.map((x,i)=>`<div class="list-item"><div><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.category)} · ${escapeHtml(x.memo||'매월 반영')}</span></div><strong>${fmt.format(x.amount)}</strong><button data-fixed-delete="${i}" type="button">삭제</button></div>`).join('') : '<div class="empty">매월 나가는 고정지출을 입력하세요.</div>';
}
function renderAssets(){
  const inv = investmentTotals();
  const computed = [{ type:'국내주식', name:'투자관리 합계', amount:inv.domestic, readonly:true },{ type:'해외주식', name:'투자관리 합계', amount:inv.foreign, readonly:true },{ type:'CMA', name:'투자관리 합계', amount:inv.cma, readonly:true }].filter(x=>x.amount>0);
  const list = [...state.assets, ...computed];
  $('assetList').innerHTML = list.length ? list.map((a,i)=>`<div class="asset-item"><b>${escapeHtml(a.name)}</b><b>${fmt.format(a.amount)}</b><span>${escapeHtml(a.type)}${a.readonly?' · 자동연동':''}</span>${a.readonly?'':`<button type="button" data-asset-delete="${i}">삭제</button>`}</div>`).join('') : '<div class="empty">자산을 입력하면 총자산이 자동 계산됩니다.</div>';
}
function renderInvestments(){
  const t = investmentTotals();
  $('investmentResult').innerHTML = `총 투자원금 <b>${fmt.format(t.principal)}</b><br>총 평가금액 <b>${fmt.format(t.current)}</b><br>총 손익 <b>${fmt.format(t.profit)}</b> · 총 수익률 <b>${t.rate.toFixed(1)}%</b>`;
  $('investmentList').innerHTML = state.investments.length ? state.investments.map(x=>{
    const profit = num(x.current)-num(x.principal); const rate = num(x.principal)?profit/num(x.principal)*100:0;
    return `<div class="list-item"><div><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.type)} · 원금 ${fmt.format(x.principal)} · 평가 ${fmt.format(x.current)}</span></div><strong>${rate.toFixed(1)}%</strong><button data-invest-edit="${x.id}" type="button">수정</button><button data-invest-delete="${x.id}" type="button">삭제</button></div>`;
  }).join('') : '<div class="empty">투자 종목을 입력하면 개별/총 수익률이 표시됩니다.</div>';
}
function getDutyConfig(year){
  const raw = state.duty?.[year] || {};
  return {
    ...DEFAULT_DAHYE_DUTY,
    ...raw,
    holidayRate: raw.holidayRate ?? raw.weekendRate ?? DEFAULT_DAHYE_DUTY.holidayRate,
    sundayRate: raw.sundayRate ?? raw.holidayRate ?? DEFAULT_DAHYE_DUTY.sundayRate,
    months: raw.months || {}
  };
}
function renderSettings(){
  $('monthStartDay').value = state.settings.monthStartDay;
  const year = nowYear;
  const d = getDutyConfig(year);
  $('dutyYear').value = year;
  $('dahyeBasePay').value = d.basePay || '';
  $('weekdayRate').value = d.weekdayRate || '';
  $('holidayRate').value = d.holidayRate || '';
  $('sundayRate').value = d.sundayRate || '';
  $('monThuAssistRate').value = d.monThuAssistRate || '';
  $('friAssistRate').value = d.friAssistRate || '';
  $('vehicleSupport').value = d.vehicleSupport || '';
  $('otherAllowance').value = d.otherAllowance || '';
  $('pensionRate').value = d.pensionRate ?? DEFAULT_DAHYE_DUTY.pensionRate;
  $('healthRate').value = d.healthRate ?? DEFAULT_DAHYE_DUTY.healthRate;
  $('careRate').value = d.careRate ?? DEFAULT_DAHYE_DUTY.careRate;
  $('employmentRate').value = d.employmentRate ?? DEFAULT_DAHYE_DUTY.employmentRate;
  $('incomeTax').value = d.incomeTax ?? DEFAULT_DAHYE_DUTY.incomeTax;
  $('localTaxRate').value = d.localTaxRate ?? DEFAULT_DAHYE_DUTY.localTaxRate;
  renderDutyMonths(year);
  $('householdId').value = sync.householdId || DEFAULT_HOUSEHOLD_ID; $('firebaseConfig').value = sync.configText || '';
}
function renderDutyMonths(year){
  const d = getDutyConfig(year); const months = d.months || {};
  $('dutyMonths').innerHTML = Array.from({length:12},(_,i)=>i+1).map(m=>{
    const row = months[m] || {};
    return `<div class="duty-row"><b>${m}월</b><input data-duty-month="${m}" data-duty-type="weekday" type="number" min="0" placeholder="평일" value="${row.weekday||''}"><input data-duty-month="${m}" data-duty-type="holiday" type="number" min="0" placeholder="휴일" value="${row.holiday ?? row.weekend ?? ''}"><input data-duty-month="${m}" data-duty-type="sunday" type="number" min="0" placeholder="일요일" value="${row.sunday ?? ''}"><input data-duty-month="${m}" data-duty-type="monThuAssist" type="number" min="0" placeholder="월/목 보조" value="${row.monThuAssist ?? ''}"><input data-duty-month="${m}" data-duty-type="friAssist" type="number" min="0" placeholder="금 보조" value="${row.friAssist ?? ''}"></div>`;
  }).join('');
}
function fillSelects(){
  const exp=$('expenseCategory'); if(exp && exp.options.length!==EXPENSE_CATEGORIES.length) exp.innerHTML=EXPENSE_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('');
  const fixed=$('fixedCategory'); if(fixed && fixed.options.length!==FIXED_CATEGORIES.length) fixed.innerHTML=FIXED_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('');
  const asset=$('assetType'); if(asset && asset.options.length!==ASSET_TYPES.length) asset.innerHTML=ASSET_TYPES.map(c=>`<option value="${c}">${c}</option>`).join('');
  if($('monthStartDay').options.length<28) $('monthStartDay').innerHTML = Array.from({length:28},(_,i)=>`<option value="${i+1}">매월 ${i+1}일</option>`).join('');
}
function roundDownTen(value){ return Math.floor(num(value) / 10) * 10; }
function dahyeDutyPay(date){
  const y = new Date(date).getFullYear(); const m = new Date(date).getMonth()+1; const d = getDutyConfig(y); const row = d.months?.[m] || {};
  const weekday = num(row.weekday)*num(d.weekdayRate);
  const holiday = num(row.holiday ?? row.weekend)*num(d.holidayRate);
  const sunday = num(row.sunday)*num(d.sundayRate);
  const monThuAssist = num(row.monThuAssist)*num(d.monThuAssistRate);
  const friAssist = num(row.friAssist)*num(d.friAssistRate);
  return { weekday, holiday, sunday, monThuAssist, friAssist, total: weekday + holiday + sunday + monThuAssist + friAssist, counts: row, config: d };
}
function calculateDahyeSalary(date, baseOverride){
  const y = new Date(date).getFullYear();
  const d = getDutyConfig(y);
  const duty = dahyeDutyPay(date);
  const base = num(baseOverride || d.basePay);
  const taxable = base + duty.total + num(d.otherAllowance);
  const gross = taxable + num(d.vehicleSupport);
  const pension = roundDownTen(taxable * num(d.pensionRate) / 100);
  const health = taxable * num(d.healthRate) / 100;
  const care = roundDownTen(health * num(d.careRate) / 100);
  const employment = roundDownTen(taxable * num(d.employmentRate) / 100);
  const incomeTax = num(d.incomeTax);
  const localTax = roundDownTen(incomeTax * num(d.localTaxRate) / 100);
  const deduction = pension + health + care + employment + incomeTax + localTax;
  const net = gross - deduction;
  return { base, dutyTotal:duty.total, duty, taxable, vehicleSupport:num(d.vehicleSupport), otherAllowance:num(d.otherAllowance), gross, pension, health, care, employment, incomeTax, localTax, deduction, net };
}
function dutyPay(owner, date){
  if(owner !== '다혜') return 0;
  return dahyeDutyPay(date).total;
}
function updateDutyBox(){
  const owner=$('salaryOwner').value, date=$('salaryDate').value || todayISO();
  $('dahyeDutyBox').classList.toggle('hidden', owner!=='다혜');
  if(owner !== '다혜'){ $('dahyeDutyBox').innerHTML = ''; return; }
  const base = num($('salaryBase').value) || getDutyConfig(new Date(date).getFullYear()).basePay;
  const calc = calculateDahyeSalary(date, base);
  $('salaryBase').placeholder = `기본급 기본값 ${fmt.format(calc.base)}`;
  $('dahyeDutyBox').innerHTML = `<b>다혜 세후 예상액: ${fmt.format(calc.net)}</b><br>기본급 ${fmt.format(calc.base)} + 당직/보조 ${fmt.format(calc.dutyTotal)} = 과세합계 ${fmt.format(calc.taxable)}<br>공제합계 ${fmt.format(calc.deduction)} <span class="muted">(국민 ${fmt.format(calc.pension)}, 건강 ${fmt.format(calc.health)}, 요양 ${fmt.format(calc.care)}, 고용 ${fmt.format(calc.employment)}, 소득세 ${fmt.format(calc.incomeTax)}, 주민세 ${fmt.format(calc.localTax)})</span>`;
}
function bindEvents(){
  document.querySelectorAll('.bottom-nav button').forEach(btn=>btn.addEventListener('click',()=>{ document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.dataset.page===btn.dataset.target)); renderAll(); }));
  $('expenseDate').value = todayISO(); $('salaryDate').value = todayISO();
  $('expenseForm').addEventListener('submit', e=>{ e.preventDefault(); const id=$('expenseEditId').value; const payload={ type:'expense', payer:$('expensePayer').value, owner:$('expensePayer').value, date:$('expenseDate').value, category:$('expenseCategory').value, amount:num($('expenseAmount').value), memo:$('expenseMemo').value };
    if(id){ const idx=state.entries.findIndex(x=>x.id===id); if(idx>-1) state.entries[idx]={...state.entries[idx],...payload,updatedAt:Date.now()}; addLog('지출 수정', payload.memo); }
    else { state.entries.push({ id:uid(), ...payload, createdAt:Date.now() }); addLog('지출 입력', `${payload.category} ${fmt.format(payload.amount)}`); }
    resetExpenseForm(); scheduleRemoteSave(); renderAll(); });
  $('expenseCancelBtn').addEventListener('click', resetExpenseForm);
  $('salaryOwner').addEventListener('change', updateDutyBox); $('salaryDate').addEventListener('change', updateDutyBox); $('salaryBase').addEventListener('input', updateDutyBox);
  $('salaryForm').addEventListener('submit', e=>{ e.preventDefault(); const owner=$('salaryOwner').value, date=$('salaryDate').value; const base=num($('salaryBase').value); let amount=base; let memo='월급';
    if(owner==='다혜'){ const calc=calculateDahyeSalary(date, base || undefined); amount=Math.round(calc.net); memo=`세후월급 · 기본 ${fmt.format(calc.base)} · 당직/보조 ${fmt.format(calc.dutyTotal)} · 공제 ${fmt.format(calc.deduction)}`; }
    state.entries.push({ id:uid(), type:'income', owner, payer:owner, date, category:'월급', amount, memo, createdAt:Date.now() }); addLog('월급 입력', `${owner} ${fmt.format(amount)}`); e.target.reset(); $('salaryDate').value=todayISO(); updateDutyBox(); scheduleRemoteSave(); renderAll(); });
  $('budgetMonth').addEventListener('change', ()=>{ $('foodBudgetInput').value = num(monthlyBudget($('budgetMonth').value).식비) || ''; });
  $('monthlyBudgetForm').addEventListener('submit', e=>{ e.preventDefault(); const key=$('budgetMonth').value; state.monthlyBudgets[key] = { ...(state.monthlyBudgets[key]||{}), 식비:num($('foodBudgetInput').value) }; addLog('월 예산 저장', key); scheduleRemoteSave(); renderAll(); });
  $('annualBudgetYear').addEventListener('change', renderAnnualBudgetFields);
  $('annualBudgetForm').addEventListener('submit', e=>{ e.preventDefault(); const y=num($('annualBudgetYear').value); state.annualBudgets[y] = {}; document.querySelectorAll('[data-annual-budget-cat]').forEach(inp=>state.annualBudgets[y][inp.dataset.annualBudgetCat]=num(inp.value)); addLog('연 예산 저장', String(y)); scheduleRemoteSave(); renderAll(); });
  $('fixedForm').addEventListener('submit', e=>{ e.preventDefault(); state.fixedExpenses.push({ id:uid(), name:$('fixedName').value, category:$('fixedCategory').value, amount:num($('fixedAmount').value), memo:$('fixedMemo').value, active:true }); addLog('고정지출 추가', $('fixedName').value); e.target.reset(); scheduleRemoteSave(); renderAll(); });
  $('assetForm').addEventListener('submit', e=>{ e.preventDefault(); state.assets.push({ id:uid(), type:$('assetType').value, name:$('assetName').value, amount:num($('assetAmount').value) }); addLog('자산 추가', $('assetName').value); e.target.reset(); scheduleRemoteSave(); renderAll(); });
  $('investmentForm').addEventListener('submit', e=>{ e.preventDefault(); const id=$('investEditId').value; const payload={ type:$('investType').value, name:$('investName').value, principal:num($('investPrincipal').value), current:num($('investCurrent').value) };
    if(id){ const idx=state.investments.findIndex(x=>x.id===id); if(idx>-1) state.investments[idx]={...state.investments[idx],...payload}; addLog('투자 수정', payload.name); }
    else { state.investments.push({ id:uid(), ...payload }); addLog('투자 추가', payload.name); }
    resetInvestForm(); scheduleRemoteSave(); renderAll(); });
  $('investCancelBtn').addEventListener('click', resetInvestForm);
  $('settingsForm').addEventListener('submit', e=>{ e.preventDefault(); state.settings.monthStartDay = num($('monthStartDay').value); scheduleRemoteSave(); renderAll(); });
  $('dutyYear').addEventListener('change', e=>renderDutyMonths(num(e.target.value)));
  $('dutyForm').addEventListener('submit', e=>{ e.preventDefault(); const y=num($('dutyYear').value); const months={}; document.querySelectorAll('[data-duty-month]').forEach(inp=>{ const m=inp.dataset.dutyMonth; months[m]=months[m]||{}; months[m][inp.dataset.dutyType]=num(inp.value); }); state.duty[y] = { basePay:num($('dahyeBasePay').value), weekdayRate:num($('weekdayRate').value), holidayRate:num($('holidayRate').value), sundayRate:num($('sundayRate').value), monThuAssistRate:num($('monThuAssistRate').value), friAssistRate:num($('friAssistRate').value), vehicleSupport:num($('vehicleSupport').value), otherAllowance:num($('otherAllowance').value), pensionRate:num($('pensionRate').value), healthRate:num($('healthRate').value), careRate:num($('careRate').value), employmentRate:num($('employmentRate').value), incomeTax:num($('incomeTax').value), localTaxRate:num($('localTaxRate').value), months }; addLog('다혜 급여 설정 저장', String(y)); scheduleRemoteSave(); renderAll(); });
  document.addEventListener('click', e=>{ const t=e.target;
    if(t.dataset.expEdit) startEditExpense(t.dataset.expEdit); if(t.dataset.expDelete) deleteExpense(t.dataset.expDelete);
    if(t.dataset.fixedDelete){ state.fixedExpenses.splice(num(t.dataset.fixedDelete),1); scheduleRemoteSave(); renderAll(); }
    if(t.dataset.assetDelete){ state.assets.splice(num(t.dataset.assetDelete),1); scheduleRemoteSave(); renderAll(); }
    if(t.dataset.investEdit) startEditInvestment(t.dataset.investEdit); if(t.dataset.investDelete) deleteInvestment(t.dataset.investDelete);
  });
  $('backupBtn').addEventListener('click', backupData); $('restoreFile').addEventListener('change', restoreData);
  $('syncForm').addEventListener('submit', async e=>{ e.preventDefault(); sync = { householdId:$('householdId').value.trim() || DEFAULT_HOUSEHOLD_ID, configText:$('firebaseConfig').value.trim() }; localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); await connectFirebase(); });
  $('localModeBtn').addEventListener('click',()=>{ disconnectHousehold(); localStorage.removeItem(SYNC_KEY); sync={householdId:DEFAULT_HOUSEHOLD_ID,configText:''}; location.reload(); });
  $('resetBtn').addEventListener('click',()=>{ if(confirm('현재 기기의 로컬 데이터를 초기화할까요? 공동 동기화 데이터는 삭제하지 않습니다.')){ localStorage.removeItem(STORAGE_KEY); location.reload(); } });
}
function resetExpenseForm(){ $('expenseForm').reset(); $('expenseDate').value=todayISO(); $('expenseEditId').value=''; $('expenseSubmitBtn').textContent='지출 입력'; $('expenseCancelBtn').classList.add('hidden'); }
function startEditExpense(id){ const e=state.entries.find(x=>x.id===id); if(!e) return; document.querySelector('[data-target="input"]').click(); $('expenseEditId').value=e.id; $('expensePayer').value=e.payer||e.owner||'진혁'; $('expenseDate').value=e.date; $('expenseCategory').value=e.category; $('expenseAmount').value=e.amount; $('expenseMemo').value=e.memo||''; $('expenseSubmitBtn').textContent='지출 수정 저장'; $('expenseCancelBtn').classList.remove('hidden'); window.scrollTo({top:0,behavior:'smooth'}); }
function deleteExpense(id){ const e=state.entries.find(x=>x.id===id); if(!e) return; if(!confirm(`${e.memo || e.category} ${fmt.format(e.amount)} 내역을 삭제할까요?`)) return; state.entries = state.entries.filter(x=>x.id!==id); addLog('지출 삭제', e.memo || e.category); scheduleRemoteSave(); renderAll(); }
function resetInvestForm(){ $('investmentForm').reset(); $('investEditId').value=''; $('investSubmitBtn').textContent='투자자산 저장'; $('investCancelBtn').classList.add('hidden'); }
function startEditInvestment(id){ const x=state.investments.find(i=>i.id===id); if(!x) return; $('investEditId').value=x.id; $('investType').value=x.type; $('investName').value=x.name; $('investPrincipal').value=x.principal; $('investCurrent').value=x.current; $('investSubmitBtn').textContent='투자 수정 저장'; $('investCancelBtn').classList.remove('hidden'); }
function deleteInvestment(id){ const x=state.investments.find(i=>i.id===id); if(!x) return; if(!confirm(`${x.name} 투자내역을 삭제할까요?`)) return; state.investments = state.investments.filter(i=>i.id!==id); scheduleRemoteSave(); renderAll(); }
function backupData(){
  const backup = { exportedAt:new Date().toISOString(), appVersion:APP_VERSION, schemaVersion:SCHEMA_VERSION, householdId:sync.householdId, data:state };
  const blob = new Blob([JSON.stringify(backup,null,2)], {type:'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `hzzdzz-finance-backup-${new Date().toISOString().slice(0,10)}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
function restoreData(e){
  const file = e.target.files?.[0]; if(!file) return; const reader = new FileReader();
  reader.onload = () => { try{ const parsed = JSON.parse(reader.result); const restored = parsed.data || parsed; if(!confirm('백업 파일의 데이터로 복원할까요? 현재 Firebase 데이터도 복원 데이터로 갱신됩니다.')) return; state = mergeData(restored); addLog('데이터 복원', file.name); scheduleRemoteSave(); renderAll(); alert('복원이 완료되었습니다.'); }catch(err){ alert('복원 파일을 확인해주세요: '+err.message); } e.target.value=''; };
  reader.readAsText(file);
}
async function connectFirebase(){
  connectHousehold({
    configText: sync.configText,
    householdId: sync.householdId || DEFAULT_HOUSEHOLD_ID,
    onStatus: text => { $('syncStatus').textContent = text; $('syncStatus').classList.toggle('on', text==='공동 동기화'); },
    onRemoteData: data => { syncingFromRemote = true; state = mergeData(data); remoteReady = true; renderAll(); syncingFromRemote = false; },
    onMissingData: () => { remoteReady = true; return hasUserData(state) ? state : mergeData(null); },
    onError: err => { $('syncStatus').textContent='동기화 오류'; alert('Firebase 연결 오류: '+err.message); }
  });
}

bindEvents(); fillSelects(); updateDutyBox(); renderAll(); if(sync.configText) connectFirebase();
