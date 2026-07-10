import { parseFirebaseConfig, initFirebase, subscribeHousehold, saveHousehold, fetchHousehold, fetchLatestCloudBackup } from './firebase.js';
import { DEFAULT_FIREBASE_CONFIG } from './firebase-config.js';
import {
  APP_VERSION, SCHEMA_VERSION, DEFAULT_HOUSEHOLD,
  MONTHLY_CATEGORIES, YEARLY_CATEGORIES, EXPENSE_CATEGORIES,
  PURPOSE_ASSETS, DEFAULT_RATES, DEFAULT_TAX, DEFAULT_LOAN
} from './config.js';
import { $, $$, money, num, comma, moneyInput, ymd, escapeHtml, escapeAttr } from './utils.js';
import { selectedYear, selectedMonth, saveLocalViewPeriod } from './view-period.js';

let state = loadLocalState();
let firebaseReady = false;
let syncingRemote = false;
let refreshing = false;
let remoteLoaded = false;

const currentYear = () => selectedYear();

function defaultState(){
  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    settings: { cycleStartDay: 10, householdId: DEFAULT_HOUSEHOLD, firebaseConfigText: '', selectedYear: 2026, selectedMonth: new Date().getMonth()+1 },
    budgets: Object.fromEntries([...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES].map(c=>[c,0])),
    expenses: [],
    fixedByMonth: {},
    salary: { jinhyuk: {}, dahye: { base:0, rates:{...DEFAULT_RATES}, tax:{...DEFAULT_TAX}, months:{} } },
    assets: { cashItems: [], purpose: Object.fromEntries(PURPOSE_ASSETS.map(c=>[c,0])) },
    investmentSummary: { domestic:{amount:0, rate:0}, overseas:{amount:0, rate:0}, cma:{amount:0, rate:0} },
    investments: [],
    jaturi: { balance:0, history:[] },
    loan: {...DEFAULT_LOAN},
    yearData: {},
    ui: { openAccordions:{} }
  };
}
function mergeDefaults(data){
  const base = defaultState();
  const d = data || {};
  const merged = {...base, ...d};
  merged.appVersion = APP_VERSION;
  merged.schemaVersion = SCHEMA_VERSION;
  merged.settings = {...base.settings, ...(d.settings||{})};
  merged.budgets = {...base.budgets, ...(d.budgets||{})};
  // 기존 '부모님' 예산은 새 분류인 '가족'으로 자동 이전합니다.
  if(num(d.budgets?.['부모님']) && !num(d.budgets?.['가족'])) merged.budgets['가족']=num(d.budgets['부모님']);
  delete merged.budgets['부모님'];
  merged.fixedByMonth = {...base.fixedByMonth, ...(d.fixedByMonth||{})};
  merged.expenses = Array.isArray(d.expenses) ? d.expenses : [];
  merged.salary = {...base.salary, ...(d.salary||{})};
  merged.salary.jinhyuk = {...base.salary.jinhyuk, ...(d.salary?.jinhyuk||{})};
  merged.salary.dahye = {...base.salary.dahye, ...(d.salary?.dahye||{})};
  merged.salary.dahye.rates = {...base.salary.dahye.rates, ...(d.salary?.dahye?.rates||{})};
  merged.salary.dahye.tax = {...base.salary.dahye.tax, ...(d.salary?.dahye?.tax||{})};
  merged.salary.dahye.months = {...base.salary.dahye.months, ...(d.salary?.dahye?.months||{})};
  merged.investments = Array.isArray(d.investments) ? d.investments : [];
  merged.assets = migrateAssets(d.assets || {});
  merged.investmentSummary = migrateInvestSummary(d.investmentSummary, merged.investments, d.assets || {});
  merged.jaturi = {...base.jaturi, ...(d.jaturi||{})};
  merged.loan = {...base.loan, ...(d.loan||{})};
  merged.yearData = {...(d.yearData||{})};
  const legacyYear = 2026;
  if(!merged.yearData[legacyYear]){
    merged.yearData[legacyYear] = {
      budgets: JSON.parse(JSON.stringify(merged.budgets)),
      dahye: JSON.parse(JSON.stringify(merged.salary.dahye))
    };
  }
  Object.values(merged.yearData||{}).forEach(bucket=>{
    if(!bucket?.budgets) return;
    if(num(bucket.budgets['부모님']) && !num(bucket.budgets['가족'])) bucket.budgets['가족']=num(bucket.budgets['부모님']);
    delete bucket.budgets['부모님'];
  });
  merged.expenses.forEach(item=>{ if(item?.category==='부모님') item.category='가족'; });
  const activeYear = num(merged.settings.selectedYear) || legacyYear;
  if(!merged.yearData[activeYear]){
    const prev = merged.yearData[legacyYear];
    merged.yearData[activeYear] = {
      budgets: {...base.budgets},
      dahye: {base:num(prev?.dahye?.base), rates:{...base.salary.dahye.rates,...(prev?.dahye?.rates||{})}, tax:{...base.salary.dahye.tax,...(prev?.dahye?.tax||{})}, months:{}}
    };
  }
  merged.budgets = {...base.budgets, ...(merged.yearData[activeYear].budgets||{})};
  const yd = merged.yearData[activeYear].dahye || {};
  merged.salary.dahye = {...base.salary.dahye, ...yd, rates:{...base.salary.dahye.rates,...(yd.rates||{})}, tax:{...base.salary.dahye.tax,...(yd.tax||{})}, months:{...(yd.months||{})}};
  // UI 펼침 상태는 데이터가 아니므로 저장/복원하지 않습니다. 새로고침 시 항상 닫힘.
  merged.ui = {openAccordions:{}};
  return merged;
}
function migrateAssets(oldAssets){
  const purpose = Object.fromEntries(PURPOSE_ASSETS.map(k=>[k, num(oldAssets?.purpose?.[k] ?? oldAssets?.[k]) ]));
  let cashItems = Array.isArray(oldAssets?.cashItems) ? oldAssets.cashItems : [];
  if(cashItems.length === 0){
    if(num(oldAssets?.['현금'])) cashItems.push({id:crypto.randomUUID(), name:'현금', amount:num(oldAssets['현금'])});
    if(num(oldAssets?.['은행'])) cashItems.push({id:crypto.randomUUID(), name:'은행', amount:num(oldAssets['은행'])});
  }
  return {cashItems, purpose};
}
function migrateInvestSummary(existing, investments, oldAssets){
  const summary = {domestic:{amount:0,rate:0}, overseas:{amount:0,rate:0}, cma:{amount:0,rate:0}, ...(existing||{})};
  ['domestic','overseas','cma'].forEach(k=>summary[k]={amount:num(summary[k]?.amount), rate:num(summary[k]?.rate)});
  const hasSummary = summary.domestic.amount || summary.overseas.amount || summary.cma.amount;
  if(!hasSummary && Array.isArray(investments) && investments.length){
    const sums = {국내주식:{p:0,c:0}, 해외주식:{p:0,c:0}, CMA:{p:0,c:0}};
    investments.forEach(it=>{ if(sums[it.type]){ sums[it.type].p += num(it.principal); sums[it.type].c += num(it.current); }});
    summary.domestic = {amount:sums['국내주식'].c, rate:sums['국내주식'].p ? ((sums['국내주식'].c - sums['국내주식'].p)/sums['국내주식'].p*100) : 0};
    summary.overseas = {amount:sums['해외주식'].c, rate:sums['해외주식'].p ? ((sums['해외주식'].c - sums['해외주식'].p)/sums['해외주식'].p*100) : 0};
    summary.cma = {amount:sums['CMA'].c, rate:0};
  }
  if(!summary.domestic.amount && num(oldAssets?.['국내주식'])) summary.domestic.amount = num(oldAssets['국내주식']);
  if(!summary.overseas.amount && num(oldAssets?.['해외주식'])) summary.overseas.amount = num(oldAssets['해외주식']);
  if(!summary.cma.amount && num(oldAssets?.['CMA'])) summary.cma.amount = num(oldAssets['CMA']);
  return summary;
}
function saveActiveYearSnapshot(){
  const year=selectedYear();
  state.yearData=state.yearData||{};
  state.yearData[year]={
    budgets:JSON.parse(JSON.stringify(state.budgets||{})),
    dahye:JSON.parse(JSON.stringify(state.salary?.dahye||{}))
  };
}
function ensureYearBucket(year){
  state.yearData=state.yearData||{};
  if(state.yearData[year]) return;
  const current=state.salary?.dahye||{};
  state.yearData[year]={
    budgets:Object.fromEntries([...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>[c,0])),
    dahye:{base:num(current.base),rates:{...DEFAULT_RATES,...(current.rates||{})},tax:{...DEFAULT_TAX,...(current.tax||{})},months:{}}
  };
}

function applyYearBucket(year){
  ensureYearBucket(year);
  const bucket=state.yearData[year]||{};
  state.budgets={...Object.fromEntries([...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>[c,0])),...(bucket.budgets||{})};
  const d=bucket.dahye||{};
  state.salary.dahye={base:num(d.base),rates:{...DEFAULT_RATES,...(d.rates||{})},tax:{...DEFAULT_TAX,...(d.tax||{})},months:{...(d.months||{})}};
}

async function saveSelectionToFirebase(){
  persistLocal();
  render();
  clearExpenseForm();
}
async function switchYear(year){
  const next=Math.max(2020,Math.min(2100,num(year)||2026));
  if(next===selectedYear()) return;
  saveActiveYearSnapshot();
  saveLocalViewPeriod(next, selectedMonth());
  applyYearBucket(next);
  state.ui={openAccordions:{}};
  await saveSelectionToFirebase();
}
async function switchMonth(month){
  let nextYear=selectedYear();
  let nextMonth=num(month)||selectedMonth();
  if(nextMonth<1){ nextMonth=12; nextYear-=1; }
  if(nextMonth>12){ nextMonth=1; nextYear+=1; }
  nextYear=Math.max(2020,Math.min(2100,nextYear));
  if(nextYear!==selectedYear()){
    saveActiveYearSnapshot();
    applyYearBucket(nextYear);
  }
  saveLocalViewPeriod(nextYear, nextMonth);
  state.ui={openAccordions:{}};
  await saveSelectionToFirebase();
}
function loadLocalState(){ try { return mergeDefaults(JSON.parse(localStorage.getItem('hzzdzz_state_v08') || 'null')); } catch { return defaultState(); } }
function persistLocal(){ localStorage.setItem('hzzdzz_state_v08', JSON.stringify(state)); localStorage.setItem('hzzdzz_sync_settings', JSON.stringify(state.settings)); }

function saveRecoverySnapshot(label='자동복구'){
  try{
    const key='hzzdzz_recovery_snapshots_v1';
    const list=JSON.parse(localStorage.getItem(key)||'[]');
    list.unshift({savedAt:new Date().toISOString(),label,data:stripRuntime(state)});
    localStorage.setItem(key,JSON.stringify(list.slice(0,5)));
  } catch(e){ console.warn('복구 스냅샷 저장 실패',e); }
}
function assetHasValue(a){
  if(!a) return false;
  const cash=Array.isArray(a.cashItems)&&a.cashItems.some(x=>num(x?.amount)!==0 || String(x?.name||'').trim());
  const purpose=Object.values(a.purpose||{}).some(v=>num(v)!==0);
  return cash||purpose;
}
function investHasValue(v){
  return ['domestic','overseas','cma'].some(k=>num(v?.[k]?.amount)!==0 || num(v?.[k]?.rate)!==0);
}
function mergeRemoteSafely(local,remote){
  const incoming={...local,...remote,settings:{...local.settings,...(remote?.settings||{})}};
  // 구버전/빈 Firebase 값이 기입된 자산을 지우는 것을 방지합니다.
  if(assetHasValue(local?.assets) && !assetHasValue(remote?.assets)) incoming.assets=local.assets;
  if(investHasValue(local?.investmentSummary) && !investHasValue(remote?.investmentSummary)) incoming.investmentSummary=local.investmentSummary;
  return mergeDefaults(incoming);
}

function stripRuntime(s){
  const copy=JSON.parse(JSON.stringify(s));
  delete copy.updatedAt;
  delete copy.ui;
  if(copy.settings){
    delete copy.settings.selectedYear;
    delete copy.settings.selectedMonth;
  }
  return copy;
}
async function persistRemote(){
  saveActiveYearSnapshot();
  persistLocal(); render();
  if(firebaseReady && !syncingRemote){
    if(!remoteLoaded){ setBadge('동기화 확인 중','loading'); return; }
    try { await saveHousehold(stripRuntime(state)); setBadge('공동 동기화','on'); markSynced(); }
    catch(e){ console.error(e); setBadge('저장 오류','off'); alert('Firebase 저장 오류: '+e.message); }
  }
}

function getPeriod(){
  const p=periodForMonth(selectedYear(), selectedMonth());
  const startDay = Math.min(Math.max(num(state.settings.cycleStartDay)||10,1),28);
  return {...p,label:`${selectedYear()}년 ${selectedMonth()}월 (${selectedMonth()}/${startDay}~${p.end.getMonth()+1}/${p.end.getDate()})`};
}
function periodForMonth(year, month){ const startDay=Math.min(Math.max(num(state.settings.cycleStartDay)||10,1),28); return {start:new Date(year,month-1,startDay), end:new Date(year,month,startDay-1), key:`${year}-${String(month).padStart(2,'0')}`}; }
function expensesInPeriod(p){ return state.expenses.filter(e=>{ const d=new Date((e.date||'')+'T00:00:00'); return d>=new Date(p.start.toDateString()) && d<=new Date(p.end.toDateString()); }); }
function currentExpenses(){ return expensesInPeriod(getPeriod()); }
function catSpent(cat, ex=currentExpenses()){ const cats=cat==='쇼핑비'?['쇼핑비','쇼핑비(진혁)','쇼핑비(다혜)']:[cat]; return ex.filter(e=>cats.includes(e.category)).reduce((a,e)=>a+num(e.amount),0); }
function currentFixed(){ return state.fixedByMonth[getPeriod().key] || []; }
function fixedTotal(key=getPeriod().key){ return (state.fixedByMonth[key]||[]).reduce((a,f)=>a+num(f.amount),0); }
function currentJinhyukSalary(){ return num(state.salary.jinhyuk[getPeriod().key]); }
function currentDahyeSalary(){ return calcDahyeMonth(getPeriod().start.getMonth()+1).net; }
function totalBudgetSpent(){ return [...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].reduce((a,c)=>a+catSpent(c),0); }
function cashTotal(){ return (state.assets.cashItems||[]).reduce((a,it)=>a+num(it.amount),0); }
function purposeTotal(){ return Object.values(state.assets.purpose||{}).reduce((a,v)=>a+num(v),0); }
function investAssetTotal(){ return num(state.investmentSummary.domestic.amount)+num(state.investmentSummary.overseas.amount)+num(state.investmentSummary.cma.amount); }
function totalAssets(){ return cashTotal()+purposeTotal()+investAssetTotal(); }
function currentIncome(){ return currentJinhyukSalary()+currentDahyeSalary(); }
function excelRoundDown(value, digits){ const factor=Math.pow(10,-digits); return Math.trunc((Number(value)||0)/factor)*factor; }
function monthlyOverride(m, key, fallback){
  return Object.prototype.hasOwnProperty.call(m, key) ? num(m[key]) : fallback;
}
function taxDefault(t, key, fallback){
  return (Object.prototype.hasOwnProperty.call(t, key) && t[key] !== '' && t[key] !== null && t[key] !== undefined) ? num(t[key]) : fallback;
}
function rateDefault(t, key, legacyKey, fallback){
  if(Object.prototype.hasOwnProperty.call(t, key) && t[key] !== '' && t[key] !== null && t[key] !== undefined) return num(t[key]);
  const legacy = t[legacyKey];
  if(legacy !== '' && legacy !== null && legacy !== undefined && num(legacy) > 0 && num(legacy) <= 100) return num(legacy);
  return fallback;
}
function monthlyRateOverride(m, key, fallback){
  return Object.prototype.hasOwnProperty.call(m, key) && m[key] !== '' && m[key] !== null && m[key] !== undefined ? num(m[key]) : fallback;
}

function loanDueDate(startDate, installment){
  const start=new Date(`${startDate}T00:00:00`);
  const targetMonth=start.getMonth()+(installment-1);
  const y=start.getFullYear()+Math.floor(targetMonth/12);
  const m=((targetMonth%12)+12)%12;
  const day=Math.min(start.getDate(),new Date(y,m+1,0).getDate());
  return new Date(y,m,day);
}
function loanDateKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function buildLoanSchedule(){
  const l={...DEFAULT_LOAN,...(state.loan||{})};
  const rate=num(l.annualRate)/100/12;
  const total=Math.max(1,num(l.totalInstallments)||348);
  const paid=Math.max(0,Math.min(total,num(l.paidInstallments)));
  const increase=num(l.monthlyPaymentIncrease);
  const rows=[];
  let rawPrincipal=0;
  let balance=num(l.originalPrincipal);
  // 과거 회차는 동일한 체증 규칙으로 재구성합니다.
  for(let n=1;n<=paid;n++){
    if(n===1) rawPrincipal=0;
    else rawPrincipal=rawPrincipal*(1+rate)+increase;
    let principal=Math.floor(rawPrincipal);
    if(n===paid && num(l.lastPaidPrincipal)>0) principal=num(l.lastPaidPrincipal);
    const interest=Math.floor(balance*rate);
    balance=Math.max(0,balance-principal);
    rows.push({installment:n,date:loanDueDate(l.repaymentStart,n),principal,interest,payment:principal+interest,balance});
  }
  // 은행 앱에서 확인한 현재 잔액을 기준점으로 사용합니다.
  if(paid>0 && num(l.currentBalance)>0){
    balance=num(l.currentBalance);
    rows[paid-1].balance=balance;
    rawPrincipal=num(l.lastPaidPrincipal)||rawPrincipal;
  }
  for(let n=paid+1;n<=total;n++){
    rawPrincipal=rawPrincipal*(1+rate)+increase;
    let principal=Math.floor(rawPrincipal);
    if(n===total || principal>balance) principal=balance;
    const interest=Math.floor(balance*rate);
    balance=Math.max(0,balance-principal);
    rows.push({installment:n,date:loanDueDate(l.repaymentStart,n),principal,interest,payment:principal+interest,balance});
  }
  return rows;
}
function selectedLoanRow(){
  const key=`${selectedYear()}-${String(selectedMonth()).padStart(2,'0')}`;
  return buildLoanSchedule().find(r=>loanDateKey(r.date)===key) || null;
}
function loanBalanceForSelectedMonth(){
  const row=selectedLoanRow();
  if(row) return row.balance;
  const schedule=buildLoanSchedule();
  const selectedKey=`${selectedYear()}-${String(selectedMonth()).padStart(2,'0')}`;
  const first=schedule[0], last=schedule[schedule.length-1];
  if(first && selectedKey<loanDateKey(first.date)) return num(state.loan?.originalPrincipal);
  if(last && selectedKey>loanDateKey(last.date)) return 0;
  return num(state.loan?.currentBalance);
}

function calcDahyeMonth(month){
  const d=state.salary.dahye, r=d.rates||DEFAULT_RATES, t={...DEFAULT_TAX,...(d.tax||{})}, m=d.months?.[month]||{};
  const duty=num(m.weekday)*num(r.weekday)+num(m.holiday)*num(r.holiday)+num(m.sunday)*num(r.sunday)+num(m.monThu)*num(r.monThu)+num(m.friday)*num(r.friday);
  const bonus=monthlyOverride(m,'bonus',num(m.extraAllowance));
  const taxablePay=num(d.base)+duty+bonus;
  const vehicleAllowance=monthlyOverride(m,'vehicleAllowance',num(t.vehicleAllowance));
  const paymentTotal=taxablePay+vehicleAllowance;

  const pensionRate=monthlyRateOverride(m,'pensionRate',rateDefault(t,'pensionRate','pension',DEFAULT_TAX.pensionRate));
  const healthRate=monthlyRateOverride(m,'taxHealthRate',rateDefault(t,'taxHealthRate','taxHealth',DEFAULT_TAX.taxHealthRate));
  const careRate=monthlyRateOverride(m,'taxCareRate',rateDefault(t,'taxCareRate','taxCare',DEFAULT_TAX.taxCareRate));
  const employmentRate=monthlyRateOverride(m,'taxEmploymentRate',rateDefault(t,'taxEmploymentRate','taxEmployment',DEFAULT_TAX.taxEmploymentRate));
  const pension=Math.round(taxablePay * pensionRate / 100);
  const health=Math.round(taxablePay * healthRate / 100);
  const care=Math.round(health * careRate / 100);
  const employment=Math.round(taxablePay * employmentRate / 100);
  const incomeTax=monthlyOverride(m,'taxIncome',taxDefault(t,'incomeTax',0));
  const localTax=monthlyOverride(m,'taxLocal',taxDefault(t,'taxLocal',0));
  const otherDeduct=monthlyOverride(m,'taxOther',taxDefault(t,'otherDeduct',0));
  const deductions=Math.round(pension)+Math.round(health)+Math.round(care)+Math.round(employment)+Math.round(incomeTax)+Math.round(localTax)+Math.round(otherDeduct);
  const net=Math.round(paymentTotal)-deductions;
  const memoAfter=net-num(t.memoDeduct);
  return {duty,bonus,taxablePay,paymentTotal,gross:paymentTotal,vehicleAllowance,pensionRate,healthRate,careRate,employmentRate,pension,health,care,employment,incomeTax,localTax,otherDeduct,deductions,deduct:deductions,net:Math.round(net),memoAfter:Math.round(memoAfter)};
}
function yearExpenseSummary(month){ const p=periodForMonth(currentYear(), month), ex=expensesInPeriod(p), total=ex.reduce((a,e)=>a+num(e.amount),0), jin=ex.filter(e=>e.payer==='진혁').reduce((a,e)=>a+num(e.amount),0), dah=ex.filter(e=>e.payer==='다혜').reduce((a,e)=>a+num(e.amount),0), half=total/2; let settle='-'; if(jin>half) settle=`다혜→진혁 ${money(jin-half)}`; else if(dah>half) settle=`진혁→다혜 ${money(dah-half)}`; return {total,jin,dah,settle}; }
function setBadge(text, cls){ const el=$('#syncBadge'); el.textContent=text; el.className='badge '+cls; }
function formatSyncTime(date=new Date()){ return date.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function updateLastSyncLabel(){ const saved=localStorage.getItem('hzzdzz_last_sync_at'); const el=$('#lastSyncLabel'); if(el) el.textContent=saved?`마지막 업데이트 ${formatSyncTime(new Date(saved))}`:'마지막 업데이트 -'; }
function markSynced(){ localStorage.setItem('hzzdzz_last_sync_at', new Date().toISOString()); updateLastSyncLabel(); }
function showToast(message){ const el=$('#toast'); if(!el) return; el.textContent=message; el.classList.add('show'); clearTimeout(showToast._timer); showToast._timer=setTimeout(()=>el.classList.remove('show'),1800); }

function render(){ $('#periodLabel').textContent=getPeriod().label; const yl=$('#selectedYearLabel'); if(yl) yl.textContent=`${selectedYear()}년`; const ml=$('#selectedMonthLabel'); if(ml) ml.textContent=`${selectedMonth()}월`; const lt=$('#ledgerPeriodTitle'); if(lt) lt.textContent=`📅 ${selectedYear()}년 ${selectedMonth()}월 지출 내역`; renderHome(); renderLedger(); renderBudget(); renderSalary(); renderAssets(); renderInvest(); renderLoan(); renderSettings(); updateLastSyncLabel(); applyAccordionState(); }
function renderHome(){
  const assetRows=[
    ['현금', cashTotal(), true], ['투자금', investAssetTotal(), false], ...PURPOSE_ASSETS.map(k=>[k, state.assets.purpose[k], false])
  ];
  $('#assetSummaryGrid').innerHTML=assetRows.map(([k,v,click])=>`<button class="asset-chip ${click?'clickable':''}" ${click?'id="cashChip"':''}><span>${k}</span><strong>${money(v)}</strong></button>`).join('');
  $('#cashDetailHome').innerHTML=(state.assets.cashItems||[]).map(it=>`<div><span>${escapeHtml(it.name||'미입력')}</span><strong>${money(it.amount)}</strong></div>`).join('') || '<p class="hint">현금 세부 분류가 없습니다.</p>';
  $('#homeTotalAssets').textContent=money(totalAssets());
  const loanRow=selectedLoanRow();
  const selectedLoanBalance=loanBalanceForSelectedMonth();
  $('#homeLoanOutstanding').textContent=money(selectedLoanBalance);
  $('#homeNetAssets').textContent=money(totalAssets()-selectedLoanBalance);
  $('#homeNetAssets').className=(totalAssets()-selectedLoanBalance)>=0?'plus':'minus';
  $('#homeLoanPayment').textContent=money(loanRow?.payment||0);
  $('#homeLoanPrincipal').textContent=money(loanRow?.principal||0);
  $('#homeLoanInterest').textContent=money(loanRow?.interest||0);
  $('#homeLoanBalance').textContent=money(selectedLoanBalance);
  $('#loanHomeSummary').textContent=loanRow?money(loanRow.payment):money(selectedLoanBalance);

  const j=currentJinhyukSalary(), d=currentDahyeSalary(), income=j+d, fixed=fixedTotal(), spent=totalBudgetSpent(), surplus=income-fixed-spent;
  $('#homeJinhyukSalary').textContent=money(j); $('#homeDahyeSalary').textContent=money(d); $('#homeIncome').textContent=money(income); $('#homeFixed').textContent=money(fixed); $('#homeBudgetSpent').textContent=money(spent); $('#homeSurplus').textContent=money(surplus); $('#homeSurplus').className=surplus>=0?'plus':'minus';
  $('#incomeAccSummary').textContent=`잉여 ${money(surplus)}`;

  $('#homeBudgetTable tbody').innerHTML=[...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>{ const b=num(state.budgets[c]), s=catSpent(c), bal=b-s; return `<tr><td>${c}</td><td>${MONTHLY_CATEGORIES.includes(c)?'월별':'연도별'}</td><td>${money(b)}</td><td>${money(s)}</td><td class="${bal<0?'minus':'plus'}">${money(bal)}</td></tr>`; }).join('');
  $('#budgetAccSummary').textContent=`사용 ${money(spent)}`;

  $('#yearExpenseTable tbody').innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{ const r=yearExpenseSummary(m); return `<tr><td>${m}월</td><td>${money(r.total)}</td><td>${money(r.jin)}</td><td>${money(r.dah)}</td><td>${r.settle}</td></tr>`; }).join('');
  $('#expenseAccSummary').textContent=`올해 ${money(Array.from({length:12},(_,i)=>yearExpenseSummary(i+1).total).reduce((a,b)=>a+b,0))}`;

  $('#yearSalaryTable tbody').innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{ const key=`${currentYear()}-${String(m).padStart(2,'0')}`, jin=num(state.salary.jinhyuk[key]), dah=calcDahyeMonth(m).net; return `<tr><td>${m}월</td><td>${money(jin)}</td><td>${money(dah)}</td><td>${money(jin+dah)}</td></tr>`; }).join('');
  $('#salaryAccSummary').textContent=`현재 ${money(income)}`;

  $('#homeInvestTable tbody').innerHTML=`<tr><td>국내주식</td><td>${money(state.investmentSummary.domestic.amount)}</td><td>${num(state.investmentSummary.domestic.rate).toFixed(1)}%</td></tr><tr><td>해외주식</td><td>${money(state.investmentSummary.overseas.amount)}</td><td>${num(state.investmentSummary.overseas.rate).toFixed(1)}%</td></tr><tr><td>CMA</td><td>${money(state.investmentSummary.cma.amount)}</td><td>-</td></tr>`;
  $('#investAccSummary').textContent=money(investAssetTotal());
}
function renderLedger(){ const sel=$('#expenseCategory'); const selected=sel.value; sel.innerHTML=EXPENSE_CATEGORIES.map(c=>`<option>${c}</option>`).join(''); if(EXPENSE_CATEGORIES.includes(selected)) sel.value=selected; const rows=currentExpenses().sort((a,b)=>(a.date||'').localeCompare(b.date||'')); $('#ledgerTable tbody').innerHTML=rows.map(e=>`<tr><td>${e.date||''}</td><td>${escapeHtml(e.memo||'')}</td><td>${e.category}</td><td>${e.payer}</td><td>${money(e.amount)}</td><td><button class="ghost small" data-edit-exp="${e.id}">수정</button> <button class="danger small" data-del-exp="${e.id}">삭제</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">이번 월 지출내역이 없습니다.</td></tr>'; }
function renderBudget(){
  $('#budgetInputTable tbody').innerHTML=[...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>`<tr><td>${c}</td><td>${MONTHLY_CATEGORIES.includes(c)?'월별':'연도별'}</td><td><input data-money data-budget="${c}" type="text" inputmode="numeric" value="${comma(state.budgets[c])}"></td></tr>`).join('');
  const title=$('#fixedSectionTitle'); if(title) title.textContent=`💸 ${selectedYear()}년 ${selectedMonth()}월 고정지출`;
  const list=currentFixed();
  $('#fixedList').innerHTML=list.map((f,i)=>`<div class="fixed-item"><div class="fixed-row"><input placeholder="항목" data-fixed-name="${i}" value="${escapeAttr(f.name||'')}"><input type="text" inputmode="numeric" data-money placeholder="금액" data-fixed-amount="${i}" value="${comma(f.amount)}"><button class="ghost memo-btn" data-fixed-memo-toggle="${i}" title="메모 보기">📝</button><button class="danger" data-fixed-del="${i}">삭제</button></div><div class="fixed-memo hidden" data-fixed-memo-wrap="${i}"><textarea rows="3" placeholder="이 고정지출에 대한 메모를 입력하세요." data-fixed-memo="${i}">${escapeHtml(f.memo||'')}</textarea></div></div>`).join('') || '<p class="hint padded">선택한 월의 고정지출이 없습니다.</p>';
}
function renderSalary(){
  const jinTable=$('#jinhyukSalaryTable tbody');
  if(jinTable){
    jinTable.innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{
      const key=`${currentYear()}-${String(m).padStart(2,'0')}`;
      return `<tr><td>${m}월</td><td><input data-jinhyuk-month="${key}" data-money="1" inputmode="numeric" type="text" value="${moneyInput(state.salary.jinhyuk[key])}"></td></tr>`;
    }).join('');
  }
  const d=state.salary.dahye, tax={...DEFAULT_TAX,...(d.tax||{})};
  $('#dahyeBase').value=comma(d.base);
  $('#rateWeekday').value=comma(d.rates.weekday);
  $('#rateHoliday').value=comma(d.rates.holiday);
  $('#rateSunday').value=comma(d.rates.sunday);
  $('#rateMonThu').value=comma(d.rates.monThu);
  $('#rateFriday').value=comma(d.rates.friday);
  $('#taxVehicle').value=comma(tax.vehicleAllowance);
  $('#taxPension').value=rateDefault(tax,'pensionRate','pension',DEFAULT_TAX.pensionRate);
  $('#taxHealth').value=rateDefault(tax,'taxHealthRate','taxHealth',DEFAULT_TAX.taxHealthRate);
  $('#taxCare').value=rateDefault(tax,'taxCareRate','taxCare',DEFAULT_TAX.taxCareRate);
  $('#taxEmployment').value=rateDefault(tax,'taxEmploymentRate','taxEmployment',DEFAULT_TAX.taxEmploymentRate);
  $('#taxIncome').value=comma(tax.incomeTax);
  $('#taxLocal').value=tax.taxLocal === '' ? '' : comma(tax.taxLocal);
  $('#taxOther').value=comma(tax.otherDeduct);
  $('#taxMemoDeduct').value=comma(tax.memoDeduct);

  $('#dahyeDutyTable tbody').innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{
    const v=d.months[m]||{}, calc=calcDahyeMonth(m);
    return `<tr><td>${m}월</td><td><input data-duty-month="${m}" data-duty-key="weekday" type="number" value="${num(v.weekday)||''}"></td><td><input data-duty-month="${m}" data-duty-key="holiday" type="number" value="${num(v.holiday)||''}"></td><td><input data-duty-month="${m}" data-duty-key="sunday" type="number" value="${num(v.sunday)||''}"></td><td><input data-duty-month="${m}" data-duty-key="monThu" type="number" value="${num(v.monThu)||''}"></td><td><input data-duty-month="${m}" data-duty-key="friday" type="number" value="${num(v.friday)||''}"></td><td>${money(calc.duty)}</td></tr>`;
  }).join('');

  const taxTable=$('#dahyeTaxTable tbody');
  if(taxTable){
    taxTable.innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{
      const c=calcDahyeMonth(m);
      return `<tr><td>${m}월</td><td><input data-tax-month="${m}" data-tax-key="pensionRate" type="number" step="0.001" value="${c.pensionRate}"></td><td><input data-tax-month="${m}" data-tax-key="taxHealthRate" type="number" step="0.001" value="${c.healthRate}"></td><td><input data-tax-month="${m}" data-tax-key="taxCareRate" type="number" step="0.001" value="${c.careRate}"></td><td><input data-tax-month="${m}" data-tax-key="taxEmploymentRate" type="number" step="0.001" value="${c.employmentRate}"></td><td><input data-money data-tax-month="${m}" data-tax-key="taxIncome" type="text" inputmode="numeric" value="${comma(Math.round(c.incomeTax))}"></td><td><input data-money data-tax-month="${m}" data-tax-key="taxLocal" type="text" inputmode="numeric" value="${comma(Math.round(c.localTax))}"></td><td><input data-money data-tax-month="${m}" data-tax-key="taxOther" type="text" inputmode="numeric" value="${comma(Math.round(c.otherDeduct))}"></td><td>${money(c.deductions)}</td></tr>`;
    }).join('');
  }

  const bonusTable=$('#dahyeBonusTable tbody');
  if(bonusTable){
    bonusTable.innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{
      const v=d.months[m]||{};
      const bonus=Object.prototype.hasOwnProperty.call(v,'bonus') ? num(v.bonus) : num(v.extraAllowance);
      return `<tr><td>${m}월</td><td><input data-money data-bonus-month="${m}" type="text" inputmode="numeric" value="${moneyInput(bonus)}"></td></tr>`;
    }).join('');
  }

  const netTable=$('#dahyeNetTable tbody');
  if(netTable){
    netTable.innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{
      const c=calcDahyeMonth(m);
      return `<tr><td>${m}월</td><td>${money(c.paymentTotal)}</td><td>${money(c.net)}</td></tr>`;
    }).join('');
  }
}

function renderAssets(){ $('#cashItemList').innerHTML=(state.assets.cashItems||[]).map((it,i)=>`<div class="fixed-row"><input placeholder="분류명" data-cash-name="${i}" value="${escapeAttr(it.name||'')}"><input type="text" inputmode="numeric" data-money placeholder="금액" data-cash-amount="${i}" value="${comma(it.amount)}"><button class="danger" data-cash-del="${i}">삭제</button></div>`).join('') || '<p class="hint padded">현금 세부 분류를 추가해주세요.</p>'; $('#assetInputTable tbody').innerHTML=PURPOSE_ASSETS.map(c=>`<tr><td>${c}</td><td><input data-money data-purpose-asset="${c}" type="text" inputmode="numeric" value="${comma(state.assets.purpose[c])}"></td></tr>`).join(''); }
function renderInvest(){ const s=state.investmentSummary; $('#investmentTable tbody').innerHTML=`<tr><td>국내주식</td><td><input data-money data-invest-amount="domestic" type="text" inputmode="numeric" value="${comma(s.domestic.amount)}"></td><td><input data-invest-rate="domestic" type="number" step="0.1" value="${num(s.domestic.rate)}"></td></tr><tr><td>해외주식</td><td><input data-money data-invest-amount="overseas" type="text" inputmode="numeric" value="${comma(s.overseas.amount)}"></td><td><input data-invest-rate="overseas" type="number" step="0.1" value="${num(s.overseas.rate)}"></td></tr><tr><td>CMA</td><td><input data-money data-invest-amount="cma" type="text" inputmode="numeric" value="${comma(s.cma.amount)}"></td><td class="muted">-</td></tr>`; }

function renderLoan(){
  const l={...DEFAULT_LOAN,...(state.loan||{})};
  const schedule=buildLoanSchedule();
  const selected=selectedLoanRow();
  const paid=Math.max(0,Math.min(num(l.totalInstallments),num(l.paidInstallments)));
  const progress=num(l.totalInstallments)?paid/num(l.totalInstallments)*100:0;
  $('#loanNameTitle').textContent=l.name||'주택담보대출';
  $('#loanOriginal').textContent=money(l.originalPrincipal);
  $('#loanCurrentBalance').textContent=money(l.currentBalance);
  $('#loanRate').textContent=`${num(l.annualRate).toFixed(2)}%`;
  $('#loanPaidCount').textContent=`${paid} / ${num(l.totalInstallments)}`;
  $('#loanMaturity').textContent=l.maturityDate||'-';
  $('#loanProgressBar').style.width=`${Math.min(100,Math.max(0,progress))}%`;
  $('#loanProgressText').textContent=`상환 회차 기준 ${progress.toFixed(1)}% · 남은 ${Math.max(0,num(l.totalInstallments)-paid)}개월`;
  $('#loanSelectedMonthTitle').textContent=`${selectedYear()}년 ${selectedMonth()}월 상환 예정`;
  $('#loanSelectedPayment').textContent=money(selected?.payment||0);
  $('#loanSelectedPrincipal').textContent=money(selected?.principal||0);
  $('#loanSelectedInterest').textContent=money(selected?.interest||0);
  $('#loanSelectedBalance').textContent=money(selected?selected.balance:loanBalanceForSelectedMonth());
  $('#loanSelectedInstallment').textContent=selected?`${selected.installment}회차`:'해당 없음';

  $('#loanName').value=l.name||'';
  $('#loanOriginalPrincipal').value=comma(l.originalPrincipal);
  $('#loanAnnualRate').value=num(l.annualRate);
  $('#loanRepaymentStart').value=l.repaymentStart||'';
  $('#loanMaturityDate').value=l.maturityDate||'';
  $('#loanTotalInstallments').value=num(l.totalInstallments);
  $('#loanMonthlyIncrease').value=comma(l.monthlyPaymentIncrease);
  $('#loanPaidInstallments').value=num(l.paidInstallments);
  $('#loanCurrentBalanceInput').value=comma(l.currentBalance);
  $('#loanLastPaidPrincipal').value=comma(l.lastPaidPrincipal);

  $('#loanScheduleTable tbody').innerHTML=schedule.map(r=>{
    const selectedClass=(r.date.getFullYear()===selectedYear()&&r.date.getMonth()+1===selectedMonth())?' class="selected-loan-row"':'';
    return `<tr${selectedClass}><td>${r.installment}</td><td>${r.date.getFullYear()}.${String(r.date.getMonth()+1).padStart(2,'0')}.${String(r.date.getDate()).padStart(2,'0')}</td><td>${money(r.principal)}</td><td>${money(r.interest)}</td><td>${money(r.payment)}</td><td>${money(r.balance)}</td></tr>`;
  }).join('');
}

function renderSettings(){ $('#firebaseConfigText').value=state.settings.firebaseConfigText||''; $('#householdId').value=state.settings.householdId||DEFAULT_HOUSEHOLD; $('#cycleStartDay').value=state.settings.cycleStartDay||10; }
function applyAccordionState(){ $$('.accordion-content').forEach(el=>el.classList.remove('open')); $$('.accordion-toggle').forEach(btn=>btn.classList.remove('open')); Object.entries(state.ui.openAccordions||{}).forEach(([key,open])=>{ const el=$(`#acc-${key}`); const btn=document.querySelector(`[data-acc="${key}"]`); if(el){ el.classList.toggle('open',!!open); } if(btn){ btn.classList.toggle('open',!!open); }}); }

async function refreshFromFirebase(showDone=true){ if(refreshing) return; if(!firebaseReady){ const sync=JSON.parse(localStorage.getItem('hzzdzz_sync_settings')||'null'); if(sync?.firebaseConfigText){ state.settings={...state.settings,...sync}; await connectFirebase(); return; } showToast('공동 동기화 설정이 필요합니다.'); return; } try{ refreshing=true; setBadge('새로고침 중','loading'); setPullStatus('동기화 중...'); const remote=await fetchHousehold(); if(remote){ saveRecoverySnapshot('Firebase 새로고침 전');
      state=mergeRemoteSafely(state,remote); state.ui={openAccordions:{}}; remoteLoaded=true; persistLocal(); render(); } markSynced(); setBadge('공동 동기화','on'); if(showDone) showToast('최신 데이터로 업데이트되었습니다.'); } catch(e){ console.error(e); setBadge('새로고침 오류','off'); showToast('새로고침 실패: '+e.message); } finally{ refreshing=false; resetPullIndicator(); } }
function setPullStatus(text){ const el=$('#pullRefresh'); if(el) el.textContent=text; }
function resetPullIndicator(){ const el=$('#pullRefresh'); if(!el) return; el.classList.remove('visible','ready','loading'); el.style.transform='translate(-50%, -120%)'; el.textContent='아래로 당겨 새로고침'; }
function setupPullToRefresh(){ const el=$('#pullRefresh'); if(!el) return; let startY=0, tracking=false, distance=0; const threshold=76; document.addEventListener('touchstart',e=>{ if(window.scrollY<=0&&!refreshing){ startY=e.touches[0].clientY; tracking=true; distance=0; }},{passive:true}); document.addEventListener('touchmove',e=>{ if(!tracking||refreshing) return; distance=e.touches[0].clientY-startY; if(distance<=0) return; if(window.scrollY>0){ tracking=false; return; } const shown=Math.min(distance*0.55,92); el.classList.add('visible'); el.classList.toggle('ready',distance>threshold); el.textContent=distance>threshold?'놓으면 새로고침':'아래로 당겨 새로고침'; el.style.transform=`translate(-50%, ${shown-120}%)`; if(distance>18) e.preventDefault(); },{passive:false}); document.addEventListener('touchend',()=>{ if(!tracking) return; tracking=false; if(distance>threshold){ el.classList.add('loading'); el.textContent='동기화 중...'; el.style.transform='translate(-50%, 8px)'; refreshFromFirebase(true); } else resetPullIndicator(); },{passive:true}); }
async function connectFirebase(){
  try{
    setBadge('연결 중','loading');
    const configInput = ($('#firebaseConfigText')?.value || state.settings.firebaseConfigText || '').trim();
    const householdInput = ($('#householdId')?.value || state.settings.householdId || DEFAULT_HOUSEHOLD).trim();
    const cycleInput = num($('#cycleStartDay')?.value || state.settings.cycleStartDay) || 10;
    state.settings.firebaseConfigText = configInput;
    state.settings.householdId = householdInput || DEFAULT_HOUSEHOLD;
    state.settings.cycleStartDay = cycleInput;
    persistLocal();
    const cfg=parseFirebaseConfig(state.settings.firebaseConfigText || DEFAULT_FIREBASE_CONFIG);
    initFirebase(cfg);
    firebaseReady=true;
    subscribeHousehold(state.settings.householdId, async remote=>{
      syncingRemote=true;
      if(remote){
        saveRecoverySnapshot('Firebase 새로고침 전');
      state=mergeRemoteSafely(state,remote);
        applyYearBucket(selectedYear());
        state.ui={openAccordions:{}};
        remoteLoaded=true;
      } else {
        remoteLoaded=true;
        await saveHousehold(stripRuntime(state));
      }
      syncingRemote=false;
      persistLocal();
      render();
      markSynced();
      setBadge('공동 동기화','on');
    }, err=>{ console.error(err); setBadge('동기화 오류','off'); alert('동기화 오류: '+err.message); });
  } catch(e){ console.error(e); firebaseReady=false; setBadge('연결 실패','off'); alert(e.message); }
}
function selectedYearDate(){ const day=Math.min(new Date().getDate(),28); return new Date(selectedYear(), selectedMonth()-1, day); }
function clearExpenseForm(){ $('#expenseId').value=''; $('#expenseDate').value=ymd(selectedYearDate()); $('#expenseAmount').value=''; $('#expenseMemo').value=''; }
function setExpenseFormOpen(open){
  const toggle=$('#expenseFormToggle'), wrap=$('#expenseFormWrap');
  if(!toggle||!wrap) return;
  toggle.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  const label=toggle.querySelector('b'); if(label) label.textContent=open?'닫기':'보기';
  wrap.hidden=!open;
}

function bindEvents(){
  $$('.bottom-nav button').forEach(btn=>btn.addEventListener('click',()=>{ $$('.bottom-nav button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); $$('.view').forEach(v=>v.classList.remove('active')); $(`#view-${btn.dataset.view}`).classList.add('active'); }));
  $('#expenseFormToggle')?.addEventListener('click',()=>setExpenseFormOpen($('#expenseFormWrap')?.hidden));
  $('#prevYear')?.addEventListener('click',async()=>{ await switchYear(selectedYear()-1); });
  $('#nextYear')?.addEventListener('click',async()=>{ await switchYear(selectedYear()+1); });
  $('#prevMonth')?.addEventListener('click',async()=>{ await switchMonth(selectedMonth()-1); });
  $('#nextMonth')?.addEventListener('click',async()=>{ await switchMonth(selectedMonth()+1); });
  document.addEventListener('input', e=>{ const inp=e.target.closest('input[data-money]'); if(!inp) return; const raw=String(inp.value||'').replace(/[^0-9-]/g,''); inp.value=comma(raw); });
  document.addEventListener('click', async e=>{ const t=e.target.closest('button'); if(!t) return;
    if(t.dataset.acc){ const key=t.dataset.acc; state.ui.openAccordions[key]=!state.ui.openAccordions[key]; render(); }
    if(t.id==='cashChip'){ $('#cashDetailHome').classList.toggle('hidden'); }
    if(t.dataset.editExp){ const item=state.expenses.find(x=>x.id===t.dataset.editExp); if(item){ $('#expenseId').value=item.id; $('#expenseDate').value=item.date; $('#expensePayer').value=item.payer; $('#expenseCategory').value=item.category; $('#expenseAmount').value=comma(item.amount); $('#expenseMemo').value=item.memo||''; document.querySelector('[data-view="ledger"]').click(); setExpenseFormOpen(true); window.scrollTo({top:0,behavior:'smooth'}); }}
    if(t.dataset.delExp){ if(confirm('이 지출내역을 삭제하시겠습니까?')){ state.expenses=state.expenses.filter(x=>x.id!==t.dataset.delExp); await persistRemote(); }}
    if(t.id==='addFixedBtn'){ const key=getPeriod().key; state.fixedByMonth[key]=currentFixed().concat([{name:'',amount:0,memo:''}]); renderBudget(); }
    if(t.dataset.fixedMemoToggle!==undefined){ const wrap=document.querySelector(`[data-fixed-memo-wrap="${t.dataset.fixedMemoToggle}"]`); if(wrap) wrap.classList.toggle('hidden'); }
    if(t.dataset.fixedDel!==undefined){ const key=getPeriod().key, arr=currentFixed(); arr.splice(num(t.dataset.fixedDel),1); state.fixedByMonth[key]=arr; await persistRemote(); }
    if(t.id==='addCashItemBtn'){ state.assets.cashItems.push({id:crypto.randomUUID(),name:'',amount:0}); renderAssets(); }
    if(t.dataset.cashDel!==undefined){ state.assets.cashItems.splice(num(t.dataset.cashDel),1); await persistRemote(); }
  });
  $('#expenseDate').value=ymd(selectedYearDate());
  $('#expenseForm').addEventListener('submit', async e=>{ e.preventDefault(); const id=$('#expenseId').value||crypto.randomUUID(); const item={id,date:$('#expenseDate').value,payer:$('#expensePayer').value,category:$('#expenseCategory').value,amount:num($('#expenseAmount').value),memo:$('#expenseMemo').value.trim(),updatedAt:new Date().toISOString()}; const idx=state.expenses.findIndex(x=>x.id===id); if(idx>=0) state.expenses[idx]=item; else state.expenses.push(item); clearExpenseForm(); setExpenseFormOpen(false); await persistRemote(); });
  $('#expenseCancel').addEventListener('click', ()=>{ clearExpenseForm(); setExpenseFormOpen(false); });
  $('#saveBudgetBtn').addEventListener('click', async()=>{ $$('[data-budget]').forEach(i=>state.budgets[i.dataset.budget]=num(i.value)); await persistRemote(); });
  $('#fixedList').addEventListener('input', e=>{ const key=getPeriod().key, arr=currentFixed(), i=num(e.target.dataset.fixedName ?? e.target.dataset.fixedAmount ?? e.target.dataset.fixedMemo); if(e.target.dataset.fixedName!==undefined) arr[i].name=e.target.value; if(e.target.dataset.fixedAmount!==undefined) arr[i].amount=num(e.target.value); if(e.target.dataset.fixedMemo!==undefined) arr[i].memo=e.target.value; state.fixedByMonth[key]=arr; });
  $('#fixedList').addEventListener('change', persistRemote);
  $('#cashItemList').addEventListener('input', e=>{ const i=num(e.target.dataset.cashName ?? e.target.dataset.cashAmount); const arr=state.assets.cashItems; if(e.target.dataset.cashName!==undefined) arr[i].name=e.target.value; if(e.target.dataset.cashAmount!==undefined) arr[i].amount=num(e.target.value); });
  $('#cashItemList').addEventListener('change', persistRemote);
  $('#saveJinhyukSalary').addEventListener('click', async()=>{ $$('[data-jinhyuk-month]').forEach(inp=>{ state.salary.jinhyuk[inp.dataset.jinhyukMonth]=num(inp.value); }); await persistRemote(); });
  $('#saveDahyeSalary').addEventListener('click', async()=>{ const d=state.salary.dahye; d.base=num($('#dahyeBase').value); d.rates={weekday:num($('#rateWeekday').value),holiday:num($('#rateHoliday').value),sunday:num($('#rateSunday').value),monThu:num($('#rateMonThu').value),friday:num($('#rateFriday').value)}; d.tax={pensionRate:num($('#taxPension').value),taxHealthRate:num($('#taxHealth').value),taxCareRate:num($('#taxCare').value),taxEmploymentRate:num($('#taxEmployment').value),incomeTax:num($('#taxIncome').value),taxLocal:num($('#taxLocal').value),otherDeduct:num($('#taxOther').value),vehicleAllowance:num($('#taxVehicle').value),memoDeduct:num($('#taxMemoDeduct').value)}; $$('[data-duty-month]').forEach(inp=>{ const m=inp.dataset.dutyMonth,k=inp.dataset.dutyKey; d.months[m]=d.months[m]||{}; d.months[m][k]=num(inp.value); }); $$('[data-bonus-month]').forEach(inp=>{ const m=inp.dataset.bonusMonth; d.months[m]=d.months[m]||{}; d.months[m].bonus=num(inp.value); }); $$('[data-tax-month]').forEach(inp=>{ const m=inp.dataset.taxMonth,k=inp.dataset.taxKey; d.months[m]=d.months[m]||{}; d.months[m][k]=num(inp.value); }); await persistRemote(); });
  $('#saveAssetsBtn').addEventListener('click', async()=>{ $$('[data-purpose-asset]').forEach(i=>state.assets.purpose[i.dataset.purposeAsset]=num(i.value)); await persistRemote(); });
  $('#saveInvestBtn').addEventListener('click', async()=>{ ['domestic','overseas','cma'].forEach(k=>{ state.investmentSummary[k].amount=num($(`[data-invest-amount="${k}"]`)?.value); if(k!=='cma') state.investmentSummary[k].rate=num($(`[data-invest-rate="${k}"]`)?.value); }); await persistRemote(); });
  $('#saveLoanBtn').addEventListener('click', async()=>{
    state.loan={
      ...state.loan,
      name:$('#loanName').value.trim()||'신한은행 주택담보대출',
      originalPrincipal:num($('#loanOriginalPrincipal').value),
      annualRate:num($('#loanAnnualRate').value),
      repaymentStart:$('#loanRepaymentStart').value,
      maturityDate:$('#loanMaturityDate').value,
      totalInstallments:num($('#loanTotalInstallments').value),
      monthlyPaymentIncrease:num($('#loanMonthlyIncrease').value),
      paidInstallments:num($('#loanPaidInstallments').value),
      currentBalance:num($('#loanCurrentBalanceInput').value),
      lastPaidPrincipal:num($('#loanLastPaidPrincipal').value)
    };
    await persistRemote();
    showToast('대출 설정을 저장했습니다.');
  });
  $('#connectBtn').addEventListener('click', connectFirebase);
  $('#cycleStartDay').addEventListener('change', async()=>{ state.settings.cycleStartDay=num($('#cycleStartDay').value)||10; await persistRemote(); });
  $('#cloudRestoreBtn')?.addEventListener('click', async()=>{
    if(!firebaseReady){ alert('먼저 공동 동기화를 연결해주세요.'); return; }
    if(!confirm('클라우드의 가장 최근 자동 백업으로 복구하시겠습니까? 현재 상태는 복구 전에 다시 백업됩니다.')) return;
    try{
      saveRecoverySnapshot('클라우드 복구 전');
      const backup=await fetchLatestCloudBackup();
      if(!backup){ alert('사용 가능한 클라우드 백업이 없습니다.'); return; }
      state=mergeDefaults(backup);
      persistLocal(); render();
      await saveHousehold(stripRuntime(state), {forceRestore:true});
      alert('클라우드 백업 복구가 완료되었습니다.');
    }catch(e){ console.error(e); alert('클라우드 복구 실패: '+e.message); }
  });
  $('#backupBtn').addEventListener('click',()=>{ saveActiveYearSnapshot(); saveRecoverySnapshot('수동 백업'); const blob=new Blob([JSON.stringify(stripRuntime(state),null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`hzzdzz-backup-${ymd(new Date())}.json`; a.click(); URL.revokeObjectURL(a.href); });
  $('#restoreBtn').addEventListener('click',()=>$('#restoreFile').click());
  $('#restoreFile').addEventListener('change', async e=>{
    const file=e.target.files[0]; if(!file) return;
    if(!confirm('백업 파일 내용으로 Firebase 데이터를 복원합니다. 계속할까요?')) return;
    const text=await file.text();
    state=mergeDefaults(JSON.parse(text));
    persistLocal(); render();
    if(firebaseReady && remoteLoaded){
      try{ await saveHousehold(stripRuntime(state), {forceRestore:true}); markSynced(); setBadge('공동 동기화','on'); alert('복원 완료'); }
      catch(err){ console.error(err); alert('복원 실패: '+err.message); }
    } else {
      alert('복원 파일을 불러왔습니다. 공동 동기화 연결 후 다시 복원 버튼을 눌러 Firebase에 반영해주세요.');
    }
  });
  window.addEventListener('online', ()=>refreshFromFirebase(false));
}

saveLocalViewPeriod(selectedYear(), selectedMonth());
applyYearBucket(selectedYear());
bindEvents(); setupPullToRefresh(); render();
try{
  const sync=JSON.parse(localStorage.getItem('hzzdzz_sync_settings')||'null');
  const savedConfig = sync?.firebaseConfigText || state.settings?.firebaseConfigText;
  if(savedConfig || DEFAULT_FIREBASE_CONFIG){
    state.settings={...state.settings,...(sync||{}), firebaseConfigText:savedConfig||''};
    persistLocal();
    connectFirebase();
  } else setBadge('오프라인','off');
} catch { setBadge('오프라인','off'); }
