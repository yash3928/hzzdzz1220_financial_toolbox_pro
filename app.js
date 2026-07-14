import { parseFirebaseConfig, initFirebase, subscribeHousehold, saveHousehold, fetchHousehold, fetchLatestCloudBackup, getCurrentUser, observeAuth, waitForInitialAuth, loginWithEmail, logoutFirebase } from './firebase.js';
import { DEFAULT_FIREBASE_CONFIG } from './firebase-config.js';
import {
  APP_VERSION, SCHEMA_VERSION, DEFAULT_HOUSEHOLD,
  MONTHLY_CATEGORIES, YEARLY_CATEGORIES, EXPENSE_CATEGORIES,
  DEFAULT_RATES, DEFAULT_TAX, DEFAULT_LOAN
} from './config.js';
import { $, $$, money, num, comma, moneyInput, ymd, escapeHtml, escapeAttr } from './utils.js';
import { selectedYear, selectedMonth, saveLocalViewPeriod } from './view-period.js';

let state = loadLocalState();
let firebaseReady = false;
let syncingRemote = false;
let refreshing = false;
let remoteLoaded = false;
let authObserverStarted = false;
let connectionInProgress = false;
let remoteSavePending = false;
let remoteSaveRunning = false;
let deferredRemoteSnapshot = null;

const currentYear = () => selectedYear();

function defaultState(){
  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    settings: { cycleStartDay: 10, householdId: DEFAULT_HOUSEHOLD, firebaseConfigText: '', selectedYear: 2026, selectedMonth: new Date().getMonth()+1 },
    budgets: Object.fromEntries([...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES].map(c=>[c,0])),
    monthlyBudgets: {},
    budgetMemos: Object.fromEntries([...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES].map(c=>[c,''])),
    monthlyBudgetMemos: {},
    budgetAdjustments: [],
    budgetOrder: [...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES],
    expenses: [],
    fixedMaster: [],
    fixedDeletedIds: [],
    otherAssetDeletedIds: [],
    fixedByMonth: {},
    salary: { jinhyuk: {}, dahye: { base:0, rates:{...DEFAULT_RATES}, tax:{...DEFAULT_TAX}, months:{} } },
    assets: { cashItems: [], purposeItems: [] },
    investmentSummary: { domestic:{amount:0, rate:0, memo:''}, overseas:{amount:0, rate:0, memo:''}, cma:{amount:0, rate:0, memo:''} },
    investments: [],
    jaturi: { openingBalance:0, balance:0, history:[], settlements:{} },
    loan: {...DEFAULT_LOAN},
    yearData: {},
    budgetRevision: 0,
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
  merged.monthlyBudgets = {...(d.monthlyBudgets||{})};
  merged.budgetMemos = {...base.budgetMemos, ...(d.budgetMemos||{})};
  merged.monthlyBudgetMemos = {...(d.monthlyBudgetMemos||{})};
  merged.budgetAdjustments = Array.isArray(d.budgetAdjustments) ? d.budgetAdjustments : [];
  const validBudgetCategories=[...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES];
  const savedBudgetOrder=Array.isArray(d.budgetOrder)?d.budgetOrder.filter(c=>validBudgetCategories.includes(c)):[];
  merged.budgetOrder=[...savedBudgetOrder,...validBudgetCategories.filter(c=>!savedBudgetOrder.includes(c))];
  // 기존 '부모님' 예산은 새 분류인 '가족'으로 자동 이전합니다.
  if(num(d.budgets?.['부모님']) && !num(d.budgets?.['가족'])) merged.budgets['가족']=num(d.budgets['부모님']);
  delete merged.budgets['부모님'];
  // 기존 통합 쇼핑비 예산은 진혁 예산으로 우선 이전하여 총액을 보존합니다.
  if(num(d.budgets?.['쇼핑비']) && !num(d.budgets?.['쇼핑비(진혁)']) && !num(d.budgets?.['쇼핑비(다혜)'])) merged.budgets['쇼핑비(진혁)']=num(d.budgets['쇼핑비']);
  delete merged.budgets['쇼핑비'];
  merged.fixedByMonth = {...base.fixedByMonth, ...(d.fixedByMonth||{})};
  const hasFixedMasterField = Array.isArray(d.fixedMaster);
  merged.fixedMaster = hasFixedMasterField ? d.fixedMaster : [];
  merged.fixedDeletedIds = Array.isArray(d.fixedDeletedIds) ? [...new Set(d.fixedDeletedIds.map(String))] : [];
  merged.otherAssetDeletedIds = Array.isArray(d.otherAssetDeletedIds) ? [...new Set(d.otherAssetDeletedIds.map(String))] : [];
  // fixedMaster 필드가 아예 없는 구버전만 월별 자료에서 이전합니다.
  // 사용자가 모든 항목을 삭제해 빈 배열이 된 경우에는 다시 복원하지 않습니다.
  if(!hasFixedMasterField){
    const map=new Map();
    Object.entries(merged.fixedByMonth||{}).forEach(([month,items])=>(items||[]).forEach((it,idx)=>{
      const signature=`${String(it.name||'').trim()}|${String(it.owner||'공동')}`;
      if(!String(it.name||'').trim()) return;
      if(!map.has(signature)) map.set(signature,{id:it.id||crypto.randomUUID(),name:String(it.name||''),owner:it.owner||'공동',category:it.category||classifyFixedExpense(it.name),memo:String(it.memo||''),monthly:{}});
      const row=map.get(signature); row.monthly[month]={amount:num(it.amount),budget:num(it.budget ?? (String(it.name||'').includes('관리비')?it.amount:0)),memo:String(it.memo||'')};
    }));
    merged.fixedMaster=[...map.values()];
  }
  merged.fixedMaster=merged.fixedMaster.map(it=>({id:it.id||crypto.randomUUID(),name:String(it.name||''),owner:['진혁','다혜','공동'].includes(it.owner)?it.owner:'공동',category:it.category||classifyFixedExpense(it.name),memo:String(it.memo||''),monthly:{...(it.monthly||{})}})).filter(it=>!merged.fixedDeletedIds.includes(String(it.id)));
  merged.expenses = Array.isArray(d.expenses) ? d.expenses.map(e=>({...e,paid:Boolean(e?.paid)})) : [];
  merged.salary = {...base.salary, ...(d.salary||{})};
  merged.salary.jinhyuk = {...base.salary.jinhyuk, ...(d.salary?.jinhyuk||{})};
  merged.salary.dahye = {...base.salary.dahye, ...(d.salary?.dahye||{})};
  merged.salary.dahye.rates = {...base.salary.dahye.rates, ...(d.salary?.dahye?.rates||{})};
  merged.salary.dahye.tax = {...base.salary.dahye.tax, ...(d.salary?.dahye?.tax||{})};
  merged.salary.dahye.months = {...base.salary.dahye.months, ...(d.salary?.dahye?.months||{})};
  merged.investments = Array.isArray(d.investments) ? d.investments : [];
  merged.assets = migrateAssets(d.assets || {});
  merged.assets.purposeItems = (merged.assets.purposeItems||[]).filter(it=>!merged.otherAssetDeletedIds.includes(String(it?.id)));
  merged.investmentSummary = migrateInvestSummary(d.investmentSummary, merged.investments, d.assets || {});
  merged.jaturi = {...base.jaturi, ...(d.jaturi||{})};
  // 구버전에서 계산된 balance 값을 기초잔액으로 다시 더하지 않습니다.
  if(!Object.prototype.hasOwnProperty.call(d.jaturi||{},'openingBalance')) merged.jaturi.openingBalance=0;
  merged.jaturi.settlements={...(d.jaturi?.settlements||{})};
  merged.loan = {...base.loan, ...(d.loan||{})};
  merged.yearData = {...(d.yearData||{})};
  merged.budgetRevision = num(d.budgetRevision)||0;
  const legacyYear = 2026;
  if(!merged.yearData[legacyYear]){
    merged.yearData[legacyYear] = {
      budgets: JSON.parse(JSON.stringify(merged.budgets)),
      budgetMemos: JSON.parse(JSON.stringify(merged.budgetMemos||{})),
      dahye: JSON.parse(JSON.stringify(merged.salary.dahye))
    };
  }
  Object.values(merged.yearData||{}).forEach(bucket=>{
    if(!bucket?.budgets) return;
    if(num(bucket.budgets['부모님']) && !num(bucket.budgets['가족'])) bucket.budgets['가족']=num(bucket.budgets['부모님']);
    delete bucket.budgets['부모님'];
    if(num(bucket.budgets['쇼핑비']) && !num(bucket.budgets['쇼핑비(진혁)']) && !num(bucket.budgets['쇼핑비(다혜)'])) bucket.budgets['쇼핑비(진혁)']=num(bucket.budgets['쇼핑비']);
    delete bucket.budgets['쇼핑비'];
  });
  merged.expenses.forEach(item=>{
    if(item?.category==='부모님') item.category='가족';
    if(item?.category==='쇼핑비(진혁)'){ item.category='쇼핑비'; item.payer='진혁'; }
    if(item?.category==='쇼핑비(다혜)'){ item.category='쇼핑비'; item.payer='다혜'; }
  });
  // 연도별 예산은 이 기기에서 현재 선택한 연도를 기준으로 불러옵니다.
  // settings.selectedYear는 구버전 잔재일 수 있어 다른 연도 예산을 잘못 불러올 수 있습니다.
  const activeYear = selectedYear() || legacyYear;
  if(!merged.yearData[activeYear]){
    const prev = merged.yearData[legacyYear];
    merged.yearData[activeYear] = {
      budgets: {...base.budgets},
      dahye: {base:num(prev?.dahye?.base), rates:{...base.salary.dahye.rates,...(prev?.dahye?.rates||{})}, tax:{...base.salary.dahye.tax,...(prev?.dahye?.tax||{})}, months:{}}
    };
  }
  merged.budgets = {...base.budgets, ...(merged.yearData[activeYear].budgets||{})};
  merged.budgetMemos = {...base.budgetMemos, ...(merged.yearData[activeYear].budgetMemos||merged.budgetMemos||{})};
  const yd = merged.yearData[activeYear].dahye || {};
  merged.salary.dahye = {...base.salary.dahye, ...yd, rates:{...base.salary.dahye.rates,...(yd.rates||{})}, tax:{...base.salary.dahye.tax,...(yd.tax||{})}, months:{...(yd.months||{})}};
  // UI 펼침 상태는 데이터가 아니므로 저장/복원하지 않습니다. 새로고침 시 항상 닫힘.
  merged.ui = {openAccordions:{}};
  return merged;
}
function migrateAssets(oldAssets){
  let cashItems = Array.isArray(oldAssets?.cashItems) ? oldAssets.cashItems : [];
  if(cashItems.length === 0){
    if(num(oldAssets?.['현금'])) cashItems.push({id:crypto.randomUUID(), name:'현금', amount:num(oldAssets['현금'])});
    if(num(oldAssets?.['은행'])) cashItems.push({id:crypto.randomUUID(), name:'은행', amount:num(oldAssets['은행'])});
  }
  cashItems=cashItems.map(it=>({id:it?.id||crypto.randomUUID(),name:String(it?.name||''),amount:num(it?.amount),memo:String(it?.memo||'')}));

  // v1.6.21부터 기타 자산은 사용자가 직접 추가하는 배열 구조로 관리합니다.
  // 기존 연금·청약·코인·기타 값은 금액 또는 메모가 있는 항목만 안전하게 이전합니다.
  let purposeItems = Array.isArray(oldAssets?.purposeItems) ? oldAssets.purposeItems : [];
  if(!purposeItems.length){
    const legacyNames=['연금','청약','코인','기타'];
    purposeItems=legacyNames.map(name=>({
      id:crypto.randomUUID(),
      name,
      amount:num(oldAssets?.purpose?.[name] ?? oldAssets?.[name]),
      memo:String(oldAssets?.purposeMemos?.[name]||'')
    })).filter(it=>it.amount!==0 || it.memo.trim());
  }
  purposeItems=purposeItems.map(it=>({id:it?.id||crypto.randomUUID(),name:String(it?.name||''),amount:num(it?.amount),memo:String(it?.memo||'')}));
  return {cashItems, purposeItems};
}
function migrateInvestSummary(existing, investments, oldAssets){
  const summary = {domestic:{amount:0,rate:0}, overseas:{amount:0,rate:0}, cma:{amount:0,rate:0}, ...(existing||{})};
  ['domestic','overseas'].forEach(k=>summary[k]={amount:num(summary[k]?.amount), rate:num(summary[k]?.rate), memo:String(summary[k]?.memo||'')});
  const cmaSource=summary.cma||{};
  const cmaManual=Object.prototype.hasOwnProperty.call(cmaSource,'manualAmount')
    ? num(cmaSource.manualAmount)
    : Math.max(0,num(cmaSource.amount)-num(cmaSource.autoAmount));
  summary.cma={amount:cmaManual,manualAmount:cmaManual,rate:0,memo:String(cmaSource.memo||'')};
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
    budgetMemos:JSON.parse(JSON.stringify(state.budgetMemos||{})),
    dahye:JSON.parse(JSON.stringify(state.salary?.dahye||{}))
  };
}
function ensureYearBucket(year){
  state.yearData=state.yearData||{};
  if(state.yearData[year]) return;
  const current=state.salary?.dahye||{};
  state.yearData[year]={
    budgets:Object.fromEntries([...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>[c,0])),
    budgetMemos:Object.fromEntries([...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>[c,''])),
    dahye:{base:num(current.base),rates:{...DEFAULT_RATES,...(current.rates||{})},tax:{...DEFAULT_TAX,...(current.tax||{})},months:{}}
  };
}

function applyYearBucket(year){
  ensureYearBucket(year);
  const bucket=state.yearData[year]||{};
  state.budgets={...Object.fromEntries([...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>[c,0])),...(bucket.budgets||{})};
  state.budgetMemos={...Object.fromEntries([...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES].map(c=>[c,''])),...(bucket.budgetMemos||{})};
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
  // 달력 이동은 이 기기에서 열어둔 보기 상태를 유지합니다.
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
  // 달력 이동은 이 기기에서 열어둔 보기 상태를 유지합니다.
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
  const deletedIds=[...new Set([...(local?.fixedDeletedIds||[]),...(remote?.fixedDeletedIds||[])].map(String))];
  const otherAssetDeletedIds=[...new Set([...(local?.otherAssetDeletedIds||[]),...(remote?.otherAssetDeletedIds||[])].map(String))];
  const localBudgetRevision=num(local?.budgetRevision);
  const remoteBudgetRevision=num(remote?.budgetRevision);
  const incoming={...local,...remote,fixedDeletedIds:deletedIds,otherAssetDeletedIds,settings:{...local.settings,...(remote?.settings||{})}};

  // 예산은 0원도 유효한 삭제 결과입니다. 저장 직후 이전 Firebase 스냅샷이 도착해
  // 방금 저장한 0원을 되살리지 않도록 수정 시각(증가 번호)이 더 최신인 쪽을 통째로 사용합니다.
  if(localBudgetRevision>remoteBudgetRevision){
    incoming.budgets=JSON.parse(JSON.stringify(local?.budgets||{}));
    incoming.monthlyBudgets=JSON.parse(JSON.stringify(local?.monthlyBudgets||{}));
    incoming.budgetMemos=JSON.parse(JSON.stringify(local?.budgetMemos||{}));
    incoming.yearData=JSON.parse(JSON.stringify(local?.yearData||{}));
    incoming.budgetRevision=localBudgetRevision;
  }

  if(Array.isArray(incoming.fixedMaster)) incoming.fixedMaster=incoming.fixedMaster.filter(it=>!deletedIds.includes(String(it?.id)));
  if(incoming.assets && Array.isArray(incoming.assets.purposeItems)) incoming.assets.purposeItems=incoming.assets.purposeItems.filter(it=>!otherAssetDeletedIds.includes(String(it?.id)));
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
async function flushRemoteSave(){
  if(remoteSaveRunning || syncingRemote || !remoteSavePending) return;
  if(!firebaseReady){ return; }
  if(!remoteLoaded){ setBadge('동기화 확인 중','loading'); return; }
  remoteSaveRunning=true;
  remoteSavePending=false;
  const payload=stripRuntime(state);
  try {
    setBadge('전송 중','loading');
    await saveHousehold(payload);
    // 저장 전에 도착해 보류했던 스냅샷은 오래된 값일 수 있으므로 폐기합니다.
    // saveHousehold 완료 직후 onSnapshot이 최신 서버 값을 다시 전달합니다.
    deferredRemoteSnapshot=null;
    setBadge('공동 동기화','on');
    markSynced();
  } catch(e){
    console.error(e);
    remoteSavePending=true;
    setBadge('저장 오류','off');
    alert('Firebase 저장 오류: '+e.message);
  } finally {
    remoteSaveRunning=false;
    // 저장 중에 추가 변경이 생겼다면 최신 상태를 한 번 더 전송합니다.
    if(remoteSavePending && !syncingRemote) setTimeout(()=>flushRemoteSave(),0);
  }
}
async function persistRemote(){
  saveActiveYearSnapshot();
  persistLocal();
  render();
  // 원격 수신 처리 중 입력해도 저장 요청을 버리지 않고 대기시킵니다.
  remoteSavePending=true;
  await flushRemoteSave();
}

function getPeriod(){
  const p=periodForMonth(selectedYear(), selectedMonth());
  const startDay = Math.min(Math.max(num(state.settings.cycleStartDay)||10,1),28);
  return {...p,label:`${selectedYear()}년 ${selectedMonth()}월 (${selectedMonth()}/${startDay}~${p.end.getMonth()+1}/${p.end.getDate()})`};
}
function periodForMonth(year, month){ const startDay=Math.min(Math.max(num(state.settings.cycleStartDay)||10,1),28); return {start:new Date(year,month-1,startDay), end:new Date(year,month,startDay-1), key:`${year}-${String(month).padStart(2,'0')}`}; }
function expensesInPeriod(p){ return state.expenses.filter(e=>{ const d=new Date((e.date||'')+'T00:00:00'); return d>=new Date(p.start.toDateString()) && d<=new Date(p.end.toDateString()); }); }
function currentExpenses(){ return expensesInPeriod(getPeriod()); }
function catSpent(cat, ex=currentExpenses()){
  if(cat==='쇼핑비') return ex.filter(e=>['쇼핑비','쇼핑비(진혁)','쇼핑비(다혜)'].includes(e.category)).reduce((a,e)=>a+num(e.amount),0);
  if(cat==='쇼핑비(진혁)') return ex.filter(e=>(e.category==='쇼핑비' && e.payer==='진혁') || e.category==='쇼핑비(진혁)').reduce((a,e)=>a+num(e.amount),0);
  if(cat==='쇼핑비(다혜)') return ex.filter(e=>(e.category==='쇼핑비' && e.payer==='다혜') || e.category==='쇼핑비(다혜)').reduce((a,e)=>a+num(e.amount),0);
  return ex.filter(e=>e.category===cat).reduce((a,e)=>a+num(e.amount),0);
}
function classifyFixedExpense(name='',memo=''){
  const n=(String(name)+' '+String(memo)).toLowerCase();
  if(/보험|화재|생명/.test(n)) return '보험';
  if(/통신|휴대폰|skt|kt|lg|인터넷/.test(n)) return '통신';
  if(/관리비|전기|가스|수도|월세|대출|이자/.test(n)) return '주거';
  if(/넷플릭스|유튜브|구독|멤버십/.test(n)) return '구독';
  if(/자동차|주유|차량|주차/.test(n)) return '자동차';
  if(/교육|학원|도서/.test(n)) return '교육';
  if(/저축|적금|연금|청약|투자/.test(n)) return '금융';
  return '기타';
}
function fixedMonthValue(item,key=getPeriod().key){
  const raw=item?.monthly?.[key]||{};
  const amounts={공동:0,진혁:0,다혜:0,...(raw.amounts||{})};
  const memos={공동:'',진혁:'',다혜:'',...(raw.memos||{})};
  // 이전 버전의 단일 금액·메모는 지정 사용자 칸으로 자동 호환합니다.
  if(!raw.amounts && num(raw.amount)) amounts[item?.owner||'공동']=num(raw.amount);
  if(!raw.memos && raw.memo) memos[item?.owner||'공동']=String(raw.memo);
  const amount=Object.values(amounts).reduce((a,v)=>a+num(v),0);
  return {...raw,budget:amount,amounts,memos,amount,memo:Object.values(memos).filter(Boolean).join(' ')};
}
function fixedMemoText(item,key=getPeriod().key){ const v=fixedMonthValue(item,key); return Object.values(v.memos||{}).filter(Boolean).join(' '); }
function fixedCategory(item,key=getPeriod().key){ return classifyFixedExpense(item?.name||'',fixedMemoText(item,key)); }
function uniqueLabels(values){ return [...new Set(values.filter(Boolean))]; }
function fixedMemoInsight(item,key=getPeriod().key){
  const v=fixedMonthValue(item,key);
  const memoEntries=Object.entries(v.memos||{}).filter(([,memo])=>String(memo||'').trim());
  const combined=[item?.name||'',...memoEntries.map(([,memo])=>memo)].join(' ');
  const lower=combined.toLowerCase();
  const people=uniqueLabels([
    /진혁/.test(combined)?'진혁':'', /다혜/.test(combined)?'다혜':'', /공동|부부/.test(combined)?'공동':''
  ]);
  // 메모를 입력한 사용자도 분석 대상에 포함합니다.
  memoEntries.forEach(([owner])=>{ if(owner && !people.includes(owner)) people.push(owner); });
  const providers=uniqueLabels([
    /\bkt\b|케이티/.test(lower)?'KT':'',
    /\bskt\b|에스케이티|sk텔레콤/.test(lower)?'SKT':'',
    /lg\s*u\+|lgu\+|유플러스|엘지유플러스/.test(lower)?'LG U+':'',
    /알뜰폰|mvno/.test(lower)?'알뜰폰':'',
    /넷플릭스/.test(lower)?'넷플릭스':'', /유튜브/.test(lower)?'유튜브':'', /디즈니/.test(lower)?'디즈니+':''
  ]);
  const services=uniqueLabels([
    /휴대폰|핸드폰|스마트폰|모바일/.test(lower)?'휴대폰':'',
    /인터넷|와이파이|wifi/.test(lower)?'인터넷':'',
    /iptv|티비|tv/.test(lower)?'TV':'',
    /보험/.test(lower)?'보험료':'', /관리비/.test(lower)?'관리비':'',
    /대출|이자/.test(lower)?'대출·이자':'', /적금|저축/.test(lower)?'저축':'', /투자/.test(lower)?'투자':''
  ]);
  const category=fixedCategory(item,key);
  const parts=[];
  if(providers.length) parts.push(providers.join('·')+' 관련');
  if(people.length) parts.push(people.join('·')+' 사용자');
  if(services.length) parts.push(services.join('·')+' 비용');
  let sentence='';
  if(parts.length) sentence=`${parts.join(', ')}이 포함된 ${category} 항목으로 보입니다.`;
  else if(memoEntries.length) sentence=`메모 내용을 기준으로 ${category} 항목으로 분류했습니다.`;
  else sentence='세부 메모를 입력하면 사용자·업체·용도를 더 자세히 분석합니다.';
  const memoLines=memoEntries.map(([owner,memo])=>({owner,memo:String(memo).trim(),amount:num(v.amounts?.[owner])}));
  return {category,people,providers,services,sentence,memoLines,amount:num(v.amount)};
}

function parseFixedMemoItems(memo=''){
  const text=String(memo||'').replace(/\r/g,' ').replace(/\n+/g,' ').replace(/\((?:매월\s*)?\d{1,2}일[^)]*\)/g,' ').trim();
  if(!text) return [];
  const items=[];
  const re=/([^0-9]+?)\s*([0-9][0-9,]*)\s*(?:원)?(?=\s|[,/;]|$)/g;
  let match;
  while((match=re.exec(text))){
    const label=String(match[1]||'')
      .replace(/^[\s,./;:·\-]+|[\s,./;:·\-]+$/g,'')
      .replace(/\s+/g,' ')
      .trim();
    const amount=num(match[2]);
    if(label && amount>=0) items.push({label,amount});
  }
  return items;
}
function fixedDetailRows(item,key=getPeriod().key){
  const v=fixedMonthValue(item,key);
  return Object.entries(v.memos||{}).flatMap(([owner,memo])=>{
    const raw=String(memo||'').trim();
    if(!raw) return [];
    const parsed=parseFixedMemoItems(raw);
    return [{owner,raw,items:parsed,amount:num(v.amounts?.[owner])}];
  });
}
function currentFixed(){ return state.fixedMaster||[]; }
function orderedBudgetCategories(){ const valid=[...MONTHLY_CATEGORIES,...YEARLY_CATEGORIES]; const saved=Array.isArray(state.budgetOrder)?state.budgetOrder.filter(c=>valid.includes(c)):[]; return [...saved,...valid.filter(c=>!saved.includes(c))]; }
function fixedTotal(key=getPeriod().key){ return (state.fixedMaster||[]).reduce((a,f)=>a+num(fixedMonthValue(f,key).amount),0); }
function monthlyBudgetValue(category,key=getPeriod().key){
  const saved=state.monthlyBudgets?.[key];
  if(saved && Object.prototype.hasOwnProperty.call(saved,category)) return num(saved[category]);
  return num(state.budgets?.[category]);
}
function budgetMemoValue(category,key=getPeriod().key){
  if(MONTHLY_CATEGORIES.includes(category)) return String(state.monthlyBudgetMemos?.[key]?.[category]||'');
  return String(state.budgetMemos?.[category]||'');
}
function setBudgetMemoValue(category,memo,key=getPeriod().key){
  if(MONTHLY_CATEGORIES.includes(category)){
    state.monthlyBudgetMemos=state.monthlyBudgetMemos||{};
    state.monthlyBudgetMemos[key]={...(state.monthlyBudgetMemos[key]||{}),[category]:String(memo||'')};
  }else{
    state.budgetMemos=state.budgetMemos||{};
    state.budgetMemos[category]=String(memo||'');
  }
}
function budgetAdjustmentRows(){
  const year=selectedYear(), key=getPeriod().key;
  return (state.budgetAdjustments||[]).filter(x=>x.scope==='monthly'?x.periodKey===key:num(x.year)===year).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
function setMonthlyBudgetForYear(category, amount, year=selectedYear(), selectedKey=getPeriod().key){
  state.monthlyBudgets=state.monthlyBudgets||{};
  const value=Math.max(0,num(amount));
  // 선택한 달은 항상 새 값으로 저장합니다.
  state.monthlyBudgets[selectedKey]={...(state.monthlyBudgets[selectedKey]||{}),[category]:value};
  // 같은 연도의 아직 입력하지 않은 달에는 최초 설정값을 기본값으로 채웁니다.
  // 이미 월별로 따로 설정한 값은 덮어쓰지 않습니다.
  for(let month=1;month<=12;month++){
    const key=`${year}-${String(month).padStart(2,'0')}`;
    const bucket=state.monthlyBudgets[key]||{};
    if(!Object.prototype.hasOwnProperty.call(bucket,category)) state.monthlyBudgets[key]={...bucket,[category]:value};
  }
}
function managementBudget(key=getPeriod().key){ return monthlyBudgetValue('관리비',key); }
function managementFeeResult(key=getPeriod().key){
  const rows=(state.fixedMaster||[]).filter(f=>String(f.name||'').replace(/\s/g,'').includes('관리비'));
  const actual=rows.reduce((sum,f)=>sum+num(fixedMonthValue(f,key).amount),0);
  return {budget:managementBudget(key),actual};
}
function jaturiBalanceForPeriod(targetKey=getPeriod().key){
  const keys=new Set(Object.keys(state.monthlyBudgets||{}));
  (state.fixedMaster||[]).forEach(f=>Object.keys(f.monthly||{}).forEach(k=>keys.add(k)));
  let running=num(state.jaturi?.openingBalance);
  [...keys].filter(k=>k<=targetKey).sort().forEach(key=>{
    const management=managementFeeResult(key);
    running+=management.budget-management.actual;
  });
  return running;
}
function foodBaseBudget(key=getPeriod().key){ return monthlyBudgetValue('식비',key); }
function previousPeriodKey(key){
  const [y,m]=String(key).split('-').map(Number); const d=new Date(y,m-2,1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function nextPeriodKey(key){
  const [y,m]=String(key).split('-').map(Number); const d=new Date(y,m,1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function expensePeriodKey(dateText){
  const d=new Date(String(dateText||'')+'T00:00:00');
  if(Number.isNaN(d.getTime())) return '';
  const startDay=Math.min(Math.max(num(state.settings.cycleStartDay)||10,1),28);
  let y=d.getFullYear(), m=d.getMonth()+1;
  if(d.getDate()<startDay){
    const prev=new Date(y,m-2,1); y=prev.getFullYear(); m=prev.getMonth()+1;
  }
  return `${y}-${String(m).padStart(2,'0')}`;
}
function foodBudgetStatus(targetKey=getPeriod().key){
  const candidates=[targetKey,...Object.keys(state.monthlyBudgets||{})];
  (state.expenses||[]).forEach(e=>{ const key=expensePeriodKey(e?.date); if(key) candidates.push(key); });
  const valid=candidates.filter(k=>/^\d{4}-\d{2}$/.test(String(k)) && k<=targetKey).sort();
  let key=valid[0]||targetKey;
  // carryIn은 이전 달까지 남은 식비 잔액입니다.
  // 양수면 다음 달 예산에 더하고, 음수면 다음 달 예산에서 차감합니다.
  let carryIn=0, status={base:foodBaseBudget(targetKey),carryIn:0,effective:foodBaseBudget(targetKey),spent:foodSpentForKey(targetKey),carryOut:0};
  let guard=0;
  while(key<=targetKey && guard<240){
    const base=foodBaseBudget(key);
    const spent=foodSpentForKey(key);
    const effective=Math.max(0,base+carryIn);
    const carryOut=carryIn+base-spent;
    if(key===targetKey) status={base,carryIn,effective,spent,carryOut};
    carryIn=carryOut;
    key=nextPeriodKey(key);
    guard++;
  }
  return status;
}
function foodOverageFromPrevious(key=getPeriod().key){ return Math.max(0,-foodBudgetStatus(key).carryIn); }
function effectiveFoodBudget(key=getPeriod().key){ return foodBudgetStatus(key).effective; }
function dahyeNetForYearMonth(year, month){
  const source=(state.yearData?.[year]?.dahye)||((year===selectedYear())?state.salary.dahye:null);
  if(!source) return 0;
  const d=source, r={...DEFAULT_RATES,...(d.rates||{})}, t={...DEFAULT_TAX,...(d.tax||{})}, m=d.months?.[month]||{};
  const duty=num(m.weekday)*num(r.weekday)+num(m.holiday)*num(r.holiday)+num(m.sunday)*num(r.sunday)+num(m.monThu)*num(r.monThu)+num(m.friday)*num(r.friday);
  const bonus=Object.prototype.hasOwnProperty.call(m,'bonus')?num(m.bonus):num(m.extraAllowance);
  const taxablePay=num(d.base)+duty+bonus;
  const vehicleAllowance=Object.prototype.hasOwnProperty.call(m,'vehicleAllowance')?num(m.vehicleAllowance):num(t.vehicleAllowance);
  const rate=(key,legacy,fallback)=>Object.prototype.hasOwnProperty.call(m,key)?num(m[key]):rateDefault(t,key,legacy,fallback);
  const pension=Object.prototype.hasOwnProperty.call(m,'pensionAmount')?num(m.pensionAmount):taxDefault(t,'pensionAmount',0);
  const health=Math.round(taxablePay*rate('taxHealthRate','taxHealth',DEFAULT_TAX.taxHealthRate)/100);
  const care=Math.round(health*rate('taxCareRate','taxCare',DEFAULT_TAX.taxCareRate)/100);
  const employment=Math.round(taxablePay*rate('taxEmploymentRate','taxEmployment',DEFAULT_TAX.taxEmploymentRate)/100);
  const pick=(key,baseKey)=>Object.prototype.hasOwnProperty.call(m,key)?num(m[key]):num(t[baseKey]);
  const deductions=pension+health+care+employment+pick('taxIncome','incomeTax')+pick('taxLocal','taxLocal')+pick('taxOther','otherDeduct');
  return Math.round(taxablePay+vehicleAllowance)-deductions;
}
function recalculateJaturi(){
  state.jaturi=state.jaturi||{openingBalance:0,balance:0,history:[],settlements:{}};
  const settlements={};
  const keys=new Set([...Object.keys(state.monthlyBudgets||{}),...Object.keys(state.salary?.jinhyuk||{})]);
  (state.fixedMaster||[]).forEach(f=>Object.keys(f.monthly||{}).forEach(k=>keys.add(k)));
  const now=new Date(); let running=num(state.jaturi.openingBalance);
  [...keys].sort().forEach(key=>{
    const [y,m]=key.split('-').map(Number); if(!y||!m) return;
    const p=periodForMonth(y,m); if(p.end>=now) return;
    const management=managementFeeResult(key);
    const difference=management.budget-management.actual;
    running+=difference;
    const income=num(state.salary?.jinhyuk?.[key])+dahyeNetForYearMonth(y,m);
    const fixed=fixedTotal(key);
    const loanPayment=loanPaymentForKey(key);
    const foodSpent=foodSpentForKey(key);
    const investmentFund=income-fixed-loanPayment-foodSpent;
    settlements[key]={income,fixed,loanPayment,loanInterest:loanPayment,foodSpent,investmentFund,surplus:investmentFund,transferred:0,managementBudget:management.budget,managementActual:management.actual,managementDifference:difference,jaturiBalance:running};
  });
  state.jaturi.settlements=settlements;
  state.jaturi.history=Object.entries(settlements).filter(([,v])=>num(v.managementDifference)!==0).map(([key,v])=>({key,amount:num(v.managementDifference),memo:num(v.managementDifference)>0?'관리비 잉여액 적립':'관리비 초과분 차감'}));
  state.jaturi.balance=running;
  // 투자자금은 참고용 계산값으로만 사용합니다. CMA는 사용자가 직접 입력한 금액만 유지합니다.
  const cma=state.investmentSummary.cma;
  if(cma){
    const manual=Object.prototype.hasOwnProperty.call(cma,'manualAmount')?num(cma.manualAmount):num(cma.amount);
    cma.manualAmount=manual;
    cma.amount=manual;
  }
  return state.jaturi.balance;
}
function currentJinhyukSalary(){ return num(state.salary.jinhyuk[getPeriod().key]); }
function currentDahyeSalary(){ return calcDahyeMonth(getPeriod().start.getMonth()+1).net; }
function totalBudgetSpent(){
  return MONTHLY_CATEGORIES.reduce((a,c)=>a+catSpent(c),0)
    + YEARLY_CATEGORIES.reduce((a,c)=>a+annualCategorySpent(c),0);
}
function cashTotal(){ return (state.assets.cashItems||[]).reduce((a,it)=>a+num(it.amount),0); }
function purposeTotal(){ return (state.assets.purposeItems||[]).reduce((a,it)=>a+num(it.amount),0); }
function cmaAmountForPeriod(){
  const cma=state.investmentSummary.cma||{};
  return Object.prototype.hasOwnProperty.call(cma,'manualAmount')?num(cma.manualAmount):num(cma.amount);
}
function investAssetTotal(key=getPeriod().key){ return num(state.investmentSummary.domestic.amount)+num(state.investmentSummary.overseas.amount)+cmaAmountForPeriod(key); }
function totalAssets(key=getPeriod().key){ return cashTotal()+purposeTotal()+investAssetTotal(key); }
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
function loanInterestForKey(key=getPeriod().key){
  const row=buildLoanSchedule().find(r=>loanDateKey(r.date)===key);
  return num(row?.interest);
}
function loanPaymentForKey(key=getPeriod().key){
  const row=buildLoanSchedule().find(r=>loanDateKey(r.date)===key);
  return num(row?.payment);
}
function foodSpentForKey(key=getPeriod().key){
  const [year,month]=String(key).split('-').map(Number);
  if(!year||!month) return 0;
  return catSpent('식비',expensesInPeriod(periodForMonth(year,month)));
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

  const pensionAmount=monthlyOverride(m,'pensionAmount',taxDefault(t,'pensionAmount',0));
  const healthRate=monthlyRateOverride(m,'taxHealthRate',rateDefault(t,'taxHealthRate','taxHealth',DEFAULT_TAX.taxHealthRate));
  const careRate=monthlyRateOverride(m,'taxCareRate',rateDefault(t,'taxCareRate','taxCare',DEFAULT_TAX.taxCareRate));
  const employmentRate=monthlyRateOverride(m,'taxEmploymentRate',rateDefault(t,'taxEmploymentRate','taxEmployment',DEFAULT_TAX.taxEmploymentRate));
  const pension=Math.round(pensionAmount);
  // 엑셀 계산식과 동일하게 건강보험은 소수값을 유지하고,
  // 요양보험·고용보험은 각각 10원 단위 절사한 뒤 최종 세후금액만 반올림합니다.
  const health=taxablePay * healthRate / 100;
  const care=Math.floor((health * careRate / 100) / 10) * 10;
  const employment=Math.floor((taxablePay * employmentRate / 100) / 10) * 10;
  const incomeTax=monthlyOverride(m,'taxIncome',taxDefault(t,'incomeTax',0));
  const localTax=monthlyOverride(m,'taxLocal',taxDefault(t,'taxLocal',0));
  const otherDeduct=monthlyOverride(m,'taxOther',taxDefault(t,'otherDeduct',0));
  const deductions=pension+health+care+employment+Math.round(incomeTax)+Math.round(localTax)+Math.round(otherDeduct);
  const net=Math.round(paymentTotal-deductions);
  const memoAfter=net-num(t.memoDeduct);
  return {duty,bonus,taxablePay,paymentTotal,gross:paymentTotal,vehicleAllowance,pensionAmount,healthRate,careRate,employmentRate,pension,health,care,employment,incomeTax,localTax,otherDeduct,deductions,deduct:deductions,net:Math.round(net),memoAfter:Math.round(memoAfter)};
}
function yearExpenseSummary(month){ const p=periodForMonth(currentYear(), month), ex=expensesInPeriod(p), total=ex.reduce((a,e)=>a+num(e.amount),0), jin=ex.filter(e=>e.payer==='진혁').reduce((a,e)=>a+num(e.amount),0), dah=ex.filter(e=>e.payer==='다혜').reduce((a,e)=>a+num(e.amount),0); return {total,jin,dah}; }
function expensesForSelectedYearThroughMonth(){
  const start=periodForMonth(selectedYear(),1).start;
  const end=periodForMonth(selectedYear(),selectedMonth()).end;
  return state.expenses.filter(e=>{ const d=new Date((e.date||'')+'T00:00:00'); return d>=new Date(start.toDateString()) && d<=new Date(end.toDateString()); });
}
function annualCategorySpent(category){ return catSpent(category,expensesForSelectedYearThroughMonth()); }
function yearCategoryPayerSummary(month,category){
  const ex=expensesInPeriod(periodForMonth(selectedYear(),month)).filter(e=>e.category===category);
  return {
    jin:ex.filter(e=>e.payer==='진혁').reduce((a,e)=>a+num(e.amount),0),
    dah:ex.filter(e=>e.payer==='다혜').reduce((a,e)=>a+num(e.amount),0)
  };
}
function setBadge(text, cls){ const el=$('#syncBadge'); el.textContent=text; el.className='badge '+cls; }
function formatSyncTime(date=new Date()){ return date.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function updateLastSyncLabel(){ const saved=localStorage.getItem('hzzdzz_last_sync_at'); const el=$('#lastSyncLabel'); if(el) el.textContent=saved?`마지막 업데이트 ${formatSyncTime(new Date(saved))}`:'마지막 업데이트 -'; }
function markSynced(){ localStorage.setItem('hzzdzz_last_sync_at', new Date().toISOString()); updateLastSyncLabel(); }
function showToast(message){ const el=$('#toast'); if(!el) return; el.textContent=message; el.classList.add('show'); clearTimeout(showToast._timer); showToast._timer=setTimeout(()=>el.classList.remove('show'),1800); }

function render(){ recalculateJaturi(); $('#periodLabel').textContent=getPeriod().label; const yl=$('#selectedYearLabel'); if(yl) yl.textContent=`${selectedYear()}년`; const ml=$('#selectedMonthLabel'); if(ml) ml.textContent=`${selectedMonth()}월`; const lt=$('#ledgerPeriodTitle'); if(lt) lt.textContent=`📅 ${selectedYear()}년 ${selectedMonth()}월 지출 내역`; renderHome(); renderLedger(); renderBudget(); renderFixed(); renderSalary(); renderAssets(); renderInvest(); renderLoan(); renderSettings(); updateLastSyncLabel(); applyAccordionState(); }
function renderHome(){
  const assetRows=[
    ['현금', cashTotal(), true], ['투자금', investAssetTotal(), false], ...(state.assets.purposeItems||[]).map(it=>[it.name||'기타 자산', num(it.amount), false])
  ];
  $('#assetSummaryGrid').innerHTML=assetRows.map(([k,v,click])=>`<button class="asset-chip ${click?'clickable':''}" ${click?'id="cashChip"':''}><span>${k}</span><strong>${money(v)}</strong></button>`).join('');
  $('#cashDetailHome').innerHTML=(state.assets.cashItems||[]).map(it=>`<div><span>${escapeHtml(it.name||'미입력')}</span><strong>${money(it.amount)}</strong></div>`).join('') || '<p class="hint">현금 세부 분류가 없습니다.</p>';
  $('#homeTotalAssets').textContent=money(totalAssets());
  const loanRow=selectedLoanRow();
  const selectedLoanBalance=loanBalanceForSelectedMonth();
  $('#homeLoanOutstanding').textContent=money(selectedLoanBalance);
  $('#homeNetAssets').textContent=money(totalAssets()-selectedLoanBalance);
  $('#homeNetAssets').className=(totalAssets()-selectedLoanBalance)>=0?'plus':'minus';
  const homeLoanPayment=$('#homeLoanPayment'); if(homeLoanPayment) homeLoanPayment.textContent=money(loanRow?.payment||0);
  const homeLoanPrincipal=$('#homeLoanPrincipal'); if(homeLoanPrincipal) homeLoanPrincipal.textContent=money(loanRow?.principal||0);
  const homeLoanInterest=$('#homeLoanInterest'); if(homeLoanInterest) homeLoanInterest.textContent=money(loanRow?.interest||0);
  const homeLoanBalance=$('#homeLoanBalance'); if(homeLoanBalance) homeLoanBalance.textContent=money(selectedLoanBalance);
  const loanHomeSummary=$('#loanHomeSummary'); if(loanHomeSummary) loanHomeSummary.textContent=loanRow?money(loanRow.payment):money(selectedLoanBalance);

  const j=currentJinhyukSalary(), d=currentDahyeSalary(), income=j+d, fixed=fixedTotal(), spent=totalBudgetSpent();
  const loanPayment=loanPaymentForKey(), foodSpent=catSpent('식비'), investmentFund=income-fixed-loanPayment-foodSpent;
  $('#homeJinhyukSalary').textContent=money(j); $('#homeDahyeSalary').textContent=money(d); $('#homeIncome').textContent=money(income); $('#homeFixed').textContent=money(fixed);
  const fixedLabel=$('#homeFixedLabel'); if(fixedLabel) fixedLabel.textContent=`${selectedMonth()}월 고정지출`;
  const loanLabel=$('#homeLoanPaymentForFundLabel'); if(loanLabel) loanLabel.textContent=`${selectedMonth()}월 대출 납부금`;
  const loanFundEl=$('#homeLoanInterestForFund'); if(loanFundEl) loanFundEl.textContent=money(loanPayment);
  const foodFundEl=$('#homeFoodSpentForFund'); if(foodFundEl) foodFundEl.textContent=money(foodSpent);
  $('#homeSurplus').textContent=money(investmentFund); $('#homeSurplus').className=investmentFund>=0?'plus':'minus';
  $('#incomeAccSummary').textContent=`투자자금 ${money(investmentFund)}`;

  const standardBudgetRows=orderedBudgetCategories().filter(c=>!c.startsWith('쇼핑비(')).map(c=>{
    const mg=c==='관리비'?managementFeeResult():null;
    const b=c==='식비'?effectiveFoodBudget():c==='관리비'?mg.budget:num(state.budgets[c]);
    const s=c==='관리비'?mg.actual:(MONTHLY_CATEGORIES.includes(c)?catSpent(c):annualCategorySpent(c)), bal=b-s;
    return `<tr><td>${c}</td><td>${MONTHLY_CATEGORIES.includes(c)?'월별':'연도별'}</td><td>${money(b)}</td><td class="${bal<0?'minus':'plus'}">${money(bal)}</td></tr>`;
  });
  const shoppingJBudget=num(state.budgets['쇼핑비(진혁)']), shoppingDBudget=num(state.budgets['쇼핑비(다혜)']);
  const shoppingJSpent=annualCategorySpent('쇼핑비(진혁)'), shoppingDSpent=annualCategorySpent('쇼핑비(다혜)');
  const shoppingBudget=shoppingJBudget+shoppingDBudget, shoppingSpent=shoppingJSpent+shoppingDSpent, shoppingBalance=shoppingBudget-shoppingSpent;
  const shoppingRow=`<tr class="shopping-summary-row"><td><button type="button" class="shopping-budget-toggle" data-shopping-toggle>쇼핑비 <span>${state.ui.shoppingDetailOpen?'▲':'▼'}</span></button></td><td>연도별</td><td>${money(shoppingBudget)}</td><td class="${shoppingBalance<0?'minus':'plus'}">${money(shoppingBalance)}</td></tr>`;
  const shoppingDetail=state.ui.shoppingDetailOpen?`<tr class="shopping-detail-row"><td colspan="4"><div class="shopping-detail-grid"><div><b>진혁</b><span>예산 ${money(shoppingJBudget)}</span><span>지출 ${money(shoppingJSpent)}</span><strong class="${shoppingJBudget-shoppingJSpent<0?'minus':'plus'}">잔액 ${money(shoppingJBudget-shoppingJSpent)}</strong></div><div><b>다혜</b><span>예산 ${money(shoppingDBudget)}</span><span>지출 ${money(shoppingDSpent)}</span><strong class="${shoppingDBudget-shoppingDSpent<0?'minus':'plus'}">잔액 ${money(shoppingDBudget-shoppingDSpent)}</strong></div></div></td></tr>`:'';
  const insertAt=Math.min(3,standardBudgetRows.length);
  standardBudgetRows.splice(insertAt,0,shoppingRow+shoppingDetail);
  recalculateJaturi();
  const selectedJaturiBalance=jaturiBalanceForPeriod(getPeriod().key);
  standardBudgetRows.push(`<tr class="strong"><td>🐷 자투리 통장</td><td>${selectedMonth()}월 누적</td><td>-</td><td class="${selectedJaturiBalance<0?'minus':'plus'}">${money(selectedJaturiBalance)}</td></tr>`);
  $('#homeBudgetTable tbody').innerHTML=standardBudgetRows.join('');
  const budgetSummary=$('#budgetAccSummary'); if(budgetSummary) budgetSummary.textContent=state.ui.openAccordions?.budget?'닫기':'보기';

  const expenseMatrixCategories=['식비','생필품','비상금','쇼핑비','경조사비','가족'];
  $('#yearExpenseTable tbody').innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{
    const cells=expenseMatrixCategories.map(category=>{ const r=yearCategoryPayerSummary(m,category); return `<td>${money(r.dah)}</td><td>${money(r.jin)}</td>`; }).join('');
    return `<tr><td>${m}월</td>${cells}</tr>`;
  }).join('');
  $('#expenseAccSummary').textContent=`올해 ${money(Array.from({length:12},(_,i)=>yearExpenseSummary(i+1).total).reduce((a,b)=>a+b,0))}`;

  $('#yearSalaryTable tbody').innerHTML=Array.from({length:12},(_,i)=>i+1).map(m=>{ const key=`${currentYear()}-${String(m).padStart(2,'0')}`, jin=num(state.salary.jinhyuk[key]), dah=calcDahyeMonth(m).net; return `<tr><td>${m}월</td><td>${money(jin)}</td><td>${money(dah)}</td><td>${money(jin+dah)}</td></tr>`; }).join('');
  const salarySummary=$('#salaryAccSummary'); if(salarySummary) salarySummary.textContent=`현재 ${money(income)}`;

  $('#homeInvestTable tbody').innerHTML=`<tr><td>국내주식</td><td>${money(state.investmentSummary.domestic.amount)}</td><td>${num(state.investmentSummary.domestic.rate).toFixed(1)}%</td></tr><tr><td>해외주식</td><td>${money(state.investmentSummary.overseas.amount)}</td><td>${num(state.investmentSummary.overseas.rate).toFixed(1)}%</td></tr><tr><td>CMA</td><td>${money(cmaAmountForPeriod())}</td><td>-</td></tr>`;
  $('#investAccSummary').textContent=`${money(investAssetTotal())} · 평균 ${investmentAverageRate().toFixed(2)}%`;
}
function renderLedger(){ const sel=$('#expenseCategory'); const selected=sel.value; sel.innerHTML=EXPENSE_CATEGORIES.map(c=>`<option>${c}</option>`).join(''); if(EXPENSE_CATEGORIES.includes(selected)) sel.value=selected; const rows=currentExpenses().sort((a,b)=>(a.date||'').localeCompare(b.date||'')); $('#ledgerTable tbody').innerHTML=rows.map(e=>`<tr class="${e.paid?'expense-settled':''}"><td><div>${e.date||''}</div><label class="expense-paid-check"><input type="checkbox" data-exp-paid="${e.id}" ${e.paid?'checked':''}> 지급</label></td><td>${escapeHtml(e.memo||'')}</td><td>${e.category}</td><td>${e.payer}</td><td>${money(e.amount)}</td><td><button class="ghost small" data-edit-exp="${e.id}">수정</button> <button class="danger small" data-del-exp="${e.id}">삭제</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">이번 월 지출내역이 없습니다.</td></tr>'; }
function renderBudget(){
  recalculateJaturi();
  $('#budgetInputTable tbody').innerHTML=orderedBudgetCategories().map(c=>{ const label=c==='쇼핑비(진혁)'?'쇼핑비 · 진혁':c==='쇼핑비(다혜)'?'쇼핑비 · 다혜':c; const current=MONTHLY_CATEGORIES.includes(c)?monthlyBudgetValue(c):num(state.budgets[c]); const memo=budgetMemoValue(c); return `<tr data-reorder-row="budget" data-budget-category="${escapeAttr(c)}"><td class="reorder-handle">${label}</td><td>${MONTHLY_CATEGORIES.includes(c)?`${selectedMonth()}월`:'연도별'}</td><td><button type="button" class="fixed-amount-cell ${memo?'has-memo':''}" data-money-memo-type="budget" data-money-memo-key="${escapeAttr(c)}">${comma(current)}</button></td><td><input data-money data-budget-add="${escapeAttr(c)}" type="text" inputmode="numeric" placeholder="추가"></td><td><input data-money data-budget-cut="${escapeAttr(c)}" type="text" inputmode="numeric" placeholder="삭감"></td></tr>`; }).join('');
  const history=budgetAdjustmentRows();
  const historyBox=$('#budgetAdjustmentHistory');
  if(historyBox) historyBox.innerHTML=history.length?`<div class="budget-history-title">${selectedYear()}년 ${selectedMonth()}월 / 연도 추가·삭감 상세내역</div>${history.map(x=>`<div class="budget-history-row"><strong>${escapeHtml(x.category||'')}</strong><span class="${x.type==='추가'?'plus':'minus'}">${x.type} ${money(x.amount)}</span><small>${escapeHtml(x.reason||'사유 미입력')}</small></div>`).join('')}`:'<p class="hint">추가·삭감 상세내역이 없습니다.</p>';
}
function renderFixed(){
  const title=$('#fixedPageTitle'); if(title) title.textContent=`💸 ${selectedYear()}년 ${selectedMonth()}월 고정지출`;
  const key=getPeriod().key, list=currentFixed();
  const rows=list.map((f,i)=>{ const v=fixedMonthValue(f,key), cat=fixedCategory(f,key); const amountCell=owner=>`<button type="button" class="fixed-amount-cell ${v.memos?.[owner]?'has-memo':''}" data-fixed-memo-open="${i}:${owner}">${comma(v.amounts?.[owner])}</button>`; return `<tr data-reorder-row="fixed" data-fixed-id="${escapeAttr(f.id||'')}"><td class="fixed-col-name reorder-handle"><input placeholder="항목" data-fixed-name="${i}" value="${escapeAttr(f.name||'')}"></td><td class="fixed-col-ai">${escapeHtml(cat)}</td><td class="fixed-col-budget"><span class="fixed-auto-budget">${comma(v.amount)}</span></td><td class="fixed-col-owner">${amountCell('공동')}</td><td class="fixed-col-owner">${amountCell('진혁')}</td><td class="fixed-col-owner">${amountCell('다혜')}</td><td class="fixed-col-manage"><div class="fixed-manage-actions"><button class="danger small fixed-delete-btn" data-fixed-del="${i}" title="항목 삭제" aria-label="항목 삭제">삭제</button><button class="secondary small fixed-freeze-btn" data-fixed-freeze="${escapeAttr(f.id||'')}" title="전달 금액과 메모 복사" aria-label="전달 금액과 메모 복사">동결</button></div></td></tr>`; }).join('');
  const total=fixedTotal(key);
  $('#fixedList').innerHTML=`<div class="table-scroll fixed-table-scroll"><table class="excel-table input-table fixed-table"><thead><tr><th class="fixed-col-name">항목</th><th class="fixed-col-ai">AI 분류</th><th class="fixed-col-budget">예산</th><th class="fixed-col-owner">공동</th><th class="fixed-col-owner">진혁</th><th class="fixed-col-owner">다혜</th><th class="fixed-col-manage">관리</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="muted">고정지출 항목을 추가해주세요.</td></tr>'}</tbody><tfoot><tr class="fixed-total-row"><th colspan="7"><div class="fixed-total-inner"><span>총합계</span><strong>${money(total)}</strong></div></th></tr></tfoot></table></div>`;
  const detailHtml=list.filter(f=>fixedMemoText(f,key)).map(f=>{
    const v=fixedMonthValue(f,key);
    const ownerSections=fixedDetailRows(f,key).map(row=>{
      const lines=row.items.length
        ? `<ol>${row.items.map(x=>`<li><span>${escapeHtml(x.label)}</span><strong>${money(x.amount)}</strong></li>`).join('')}</ol>`
        : `<p class="fixed-detail-raw">${escapeHtml(row.raw)}</p>`;
      return `<div class="fixed-detail-owner"><b>${escapeHtml(row.owner)}</b>${lines}</div>`;
    }).join('');
    const ownerTotals={공동:0,진혁:0,다혜:0};
    fixedDetailRows(f,key).forEach(row=>{ const parsedTotal=(row.items||[]).reduce((sum,x)=>sum+num(x.amount),0); ownerTotals[row.owner]=parsedTotal||num(row.amount); });
    const ownerSummary=['공동','진혁','다혜'].filter(owner=>ownerTotals[owner]>0).map(owner=>`<span><b>${owner}</b> ${money(ownerTotals[owner])}</span>`).join('');
    return `<section class="fixed-detail-section"><header><h3>${escapeHtml(f.name||'이름 없는 항목')}</h3><strong>${money(v.amount)}</strong></header>${ownerSummary?`<div class="fixed-detail-owner-summary">${ownerSummary}</div>`:''}${ownerSections}</section>`;
  }).join('');
  $('#fixedAiSummary').innerHTML=detailHtml||'<p class="hint">고정지출 금액을 누르고 메모에 “KT 8,000 실비 5,000”처럼 입력하면 항목별로 정리해서 표시합니다.</p>';
  const mg=managementFeeResult(key); $('#managementSummary').textContent=`관리비 예산 ${money(mg.budget)} · 실제 ${money(mg.actual)} · 자투리 반영 ${money(mg.budget-mg.actual)}`;
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
  $('#taxPension').value=comma(taxDefault(tax,'pensionAmount',0));
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
      const monthData=d.months[m]||{};
      const pensionValue=Object.prototype.hasOwnProperty.call(monthData,'pensionAmount')
        ? num(monthData.pensionAmount)
        : taxDefault(tax,'pensionAmount',0);
      const c=calcDahyeMonth(m);
      return `<tr><td>${m}월</td><td><input data-money data-tax-month="${m}" data-tax-key="pensionAmount" type="text" inputmode="numeric" value="${moneyInput(pensionValue)}"></td><td>${money(c.deductions)}</td></tr>`;
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

function renderAssets(){
  const cashItems=state.assets.cashItems||[];
  const cashRows=cashItems.map((it,i)=>`<tr><td><input placeholder="항목" data-cash-name="${i}" value="${escapeAttr(it.name||'')}"></td><td><button type="button" class="fixed-amount-cell ${it.memo?'has-memo':''}" data-money-memo-type="cash" data-money-memo-key="${i}">${comma(it.amount)}</button></td><td><button class="danger small" data-cash-del="${i}">삭제</button></td></tr>`).join('');
  $('#cashItemList').innerHTML=`<div class="table-scroll asset-table-scroll"><table class="excel-table input-table asset-manage-table cash-manage-table"><thead><tr><th>항목</th><th>금액</th><th>관리</th></tr></thead><tbody>${cashRows||'<tr><td colspan="3" class="muted">현금 세부 분류를 추가해주세요.</td></tr>'}</tbody><tfoot><tr class="asset-total-row"><th>합계</th><th id="cashAssetTotal">${money(cashTotal())}</th><th></th></tr></tfoot></table></div>`;
  const purposeItems=state.assets.purposeItems||[];
  $('#assetInputTable tbody').innerHTML=purposeItems.map((it,i)=>`<tr><td>${escapeHtml(it.name||'')}</td><td><button type="button" class="fixed-amount-cell ${it.memo?'has-memo':''}" data-money-memo-type="purpose" data-money-memo-key="${i}">${comma(it.amount)}</button></td><td><div class="asset-manage-actions"><button type="button" class="ghost small" data-purpose-edit="${i}">수정</button><button type="button" class="danger small" data-purpose-del="${i}">삭제</button></div></td></tr>`).join('') || '<tr><td colspan="3" class="muted">기타 자산 항목을 추가해주세요.</td></tr>';
  $('#assetInputTable tfoot').innerHTML=`<tr class="asset-total-row"><th>합계</th><th id="purposeAssetTotal">${money(purposeTotal())}</th><th></th></tr>`;
}
function investmentAverageRate(){
  const rows=['domestic','overseas'].map(k=>state.investmentSummary[k]).filter(x=>num(x.amount)>0 && num(x.rate)>-100);
  if(!rows.length) return 0;
  const totals=rows.reduce((a,x)=>{ const principal=num(x.amount)/(1+num(x.rate)/100); return {principal:a.principal+principal,current:a.current+num(x.amount)}; },{principal:0,current:0});
  return totals.principal ? ((totals.current-totals.principal)/totals.principal*100) : 0;
}
function renderInvest(){
  const s=state.investmentSummary;
  const row=(label,key,rate=true)=>{ const shown=key==='cma'?cmaAmountForPeriod():num(s[key].amount); return `<tr><td>${label}</td><td><button type="button" class="fixed-amount-cell ${s[key].memo?'has-memo':''}" data-money-memo-type="invest" data-money-memo-key="${key}">${comma(shown)}</button></td><td>${rate?`<input data-invest-rate="${key}" type="number" step="0.1" value="${num(s[key].rate)}">`:'<span class="muted">-</span>'}</td></tr>`; };
  $('#investmentTable tbody').innerHTML=row('국내주식','domestic')+row('해외주식','overseas')+row('CMA','cma',false);
  $('#investmentTable tfoot').innerHTML=`<tr class="asset-total-row"><th>합계 / 평균</th><th id="investmentAssetTotal">${money(investAssetTotal())}</th><th id="investmentAverageRate">${investmentAverageRate().toFixed(2)}%</th></tr>`;
}
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

function setAuthGate(open, message=''){
  const gate=$('#authGate'); if(!gate) return;
  gate.hidden=!open;
  const err=$('#loginError'); if(err) err.textContent=message;
  if(open) setTimeout(()=>$('#loginEmail')?.focus(),50);
}
function renderAuthStatus(){
  const user=getCurrentUser();
  const status=$('#authStatusText'), email=$('#authEmailText'), logout=$('#logoutBtn');
  if(status) status.textContent=user?'로그인됨':'로그인 필요';
  if(email) email.textContent=user?.email||'-';
  if(logout) logout.disabled=!user;
}
function ensureAuthObserver(){
  if(authObserverStarted) return;
  authObserverStarted=true;
  observeAuth(user=>{
    renderAuthStatus();
    if(user){ setAuthGate(false); if(!firebaseReady && !connectionInProgress) setTimeout(()=>connectFirebase(),0); }
    else { firebaseReady=false; remoteLoaded=false; setBadge('로그인 필요','off'); setAuthGate(true); }
  });
}
function renderSettings(){ $('#firebaseConfigText').value=state.settings.firebaseConfigText||''; $('#householdId').value=state.settings.householdId||DEFAULT_HOUSEHOLD; $('#cycleStartDay').value=state.settings.cycleStartDay||10; renderAuthStatus(); }
function applyAccordionState(){ $$('.accordion-content').forEach(el=>el.classList.remove('open')); $$('.accordion-toggle').forEach(btn=>{btn.classList.remove('open'); const b=btn.querySelector('b'); if(b) b.textContent='보기';}); Object.entries(state.ui.openAccordions||{}).forEach(([key,open])=>{ const el=$(`#acc-${key}`); const btn=document.querySelector(`[data-acc="${key}"]`); if(el){ el.classList.toggle('open',!!open); } if(btn){ btn.classList.toggle('open',!!open); const b=btn.querySelector('b'); if(b) b.textContent=open?'닫기':'보기'; }}); }

async function refreshFromFirebase(showDone=true){ if(refreshing) return; if(!firebaseReady){ const sync=JSON.parse(localStorage.getItem('hzzdzz_sync_settings')||'null'); if(sync?.firebaseConfigText){ state.settings={...state.settings,...sync}; await connectFirebase(); return; } showToast('공동 동기화 설정이 필요합니다.'); return; } try{ refreshing=true; setBadge('새로고침 중','loading'); setPullStatus('동기화 중...'); const remote=await fetchHousehold(); if(remote){ saveRecoverySnapshot('Firebase 새로고침 전');
      const localUi=state.ui; state=mergeRemoteSafely(state,remote); state.ui=showDone?{openAccordions:{}}:(localUi||{openAccordions:{}}); remoteLoaded=true; persistLocal(); render(); } markSynced(); setBadge('공동 동기화','on'); if(showDone) showToast('최신 데이터로 업데이트되었습니다.'); } catch(e){ console.error(e); setBadge('새로고침 오류','off'); showToast('새로고침 실패: '+e.message); } finally{ refreshing=false; resetPullIndicator(); } }
function setPullStatus(text){ const el=$('#pullRefresh'); if(el) el.textContent=text; }
function resetPullIndicator(){ const el=$('#pullRefresh'); if(!el) return; el.classList.remove('visible','ready','loading'); el.style.transform='translate(-50%, -120%)'; el.textContent='아래로 당겨 새로고침'; }
function setupPullToRefresh(){ const el=$('#pullRefresh'); if(!el) return; let startY=0, tracking=false, distance=0; const threshold=76; document.addEventListener('touchstart',e=>{ if(window.scrollY<=0&&!refreshing){ startY=e.touches[0].clientY; tracking=true; distance=0; }},{passive:true}); document.addEventListener('touchmove',e=>{ if(!tracking||refreshing) return; distance=e.touches[0].clientY-startY; if(distance<=0) return; if(window.scrollY>0){ tracking=false; return; } const shown=Math.min(distance*0.55,92); el.classList.add('visible'); el.classList.toggle('ready',distance>threshold); el.textContent=distance>threshold?'놓으면 새로고침':'아래로 당겨 새로고침'; el.style.transform=`translate(-50%, ${shown-120}%)`; if(distance>18) e.preventDefault(); },{passive:false}); document.addEventListener('touchend',()=>{ if(!tracking) return; tracking=false; if(distance>threshold){ el.classList.add('loading'); el.textContent='동기화 중...'; el.style.transform='translate(-50%, 8px)'; refreshFromFirebase(true); } else resetPullIndicator(); },{passive:true}); }
async function connectFirebase(){
  if(connectionInProgress) return;
  connectionInProgress=true;
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
    await initFirebase(cfg);
    ensureAuthObserver();
    const restoredUser = getCurrentUser() || await waitForInitialAuth();
    if(!restoredUser){ firebaseReady=false; remoteLoaded=false; setBadge('로그인 필요','off'); setAuthGate(true); return; }
    firebaseReady=true;
    subscribeHousehold(state.settings.householdId, async remote=>{
      // 로컬 변경을 Firebase에 저장하는 동안에는 저장 전의 이전 스냅샷이 먼저 도착할 수 있습니다.
      // 이 값을 즉시 병합하면 사용자가 방금 0원으로 바꾼 예산이 이전 금액으로 되돌아갑니다.
      // 저장 완료 후 Firebase가 보내는 최신 스냅샷만 반영하도록 이전 스냅샷은 보류합니다.
      if(remoteSavePending || remoteSaveRunning){
        deferredRemoteSnapshot=remote;
        return;
      }
      syncingRemote=true;
      try{
        if(remote){
          saveRecoverySnapshot('Firebase 새로고침 전');
          const localUi=state.ui;
          state=mergeRemoteSafely(state,remote);
          applyYearBucket(selectedYear());
          // 공동동기화는 데이터만 반영하고, 이 기기의 보기 상태는 건드리지 않습니다.
          state.ui=localUi||{openAccordions:{}};
          remoteLoaded=true;
        } else {
          remoteLoaded=true;
          await saveHousehold(stripRuntime(state));
        }
        persistLocal();
        render();
        markSynced();
        setBadge('공동 동기화','on');
      } finally {
        syncingRemote=false;
      }
      // 원격 데이터 수신 도중 사용자가 저장한 변경이 있으면 즉시 이어서 전송합니다.
      if(remoteSavePending) setTimeout(()=>flushRemoteSave(),0);
    }, err=>{ console.error(err); setBadge('동기화 오류','off'); alert('동기화 오류: '+err.message); });
  } catch(e){ console.error(e); firebaseReady=false; setBadge('연결 실패','off'); alert(e.message); }
  finally{ connectionInProgress=false; }
}
function todayLocalDate(){ return new Date(); }
function localYmd(date){
  const d=date instanceof Date?date:new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function defaultExpenseDateForSelection(){
  const today=todayLocalDate();
  const period=getPeriod();
  const day=today.getDate();
  const startDay=Math.max(1,Math.min(28,num(state.settings?.cycleStartDay)||10));
  let candidate;
  if(day>=startDay){
    candidate=new Date(selectedYear(),selectedMonth()-1,day);
  } else {
    candidate=new Date(selectedYear(),selectedMonth(),day);
  }
  if(candidate<period.start) candidate=new Date(period.start.getFullYear(),period.start.getMonth(),period.start.getDate());
  if(candidate>period.end) candidate=new Date(period.end.getFullYear(),period.end.getMonth(),period.end.getDate());
  return localYmd(candidate);
}
function clearExpenseForm(){ $('#expenseId').value=''; $('#expenseDate').value=defaultExpenseDateForSelection(); $('#expenseAmount').value=''; $('#expenseMemo').value=''; }
function setExpenseFormOpen(open){
  const toggle=$('#expenseFormToggle'), wrap=$('#expenseFormWrap');
  if(!toggle||!wrap) return;
  if(open && !$('#expenseId')?.value) $('#expenseDate').value=defaultExpenseDateForSelection();
  toggle.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  const label=toggle.querySelector('b'); if(label) label.textContent=open?'닫기':'보기';
  wrap.hidden=!open;
}

let activeMoneyMemo = null;
function moneyMemoTarget(type,key){
  if(type==='fixed'){ const [idxRaw,ownerRaw='공동']=String(key).split(':'); const item=currentFixed()[num(idxRaw)]; if(!item) return null; const owner=['공동','진혁','다혜'].includes(ownerRaw)?ownerRaw:'공동'; const pk=getPeriod().key; const v=fixedMonthValue(item,pk); return {title:`${item.name||'고정지출'} · ${owner}`,amount:num(v.amounts?.[owner]),memo:v.memos?.[owner]||'',set:(amount,memo)=>{item.monthly=item.monthly||{}; item.monthly[pk]={...v,amounts:{...v.amounts,[owner]:num(amount)},memos:{...v.memos,[owner]:memo}}; item.category=fixedCategory(item,pk); renderFixed();}}; }
  if(type==='budget'){ const isMonthly=MONTHLY_CATEGORIES.includes(key); return {title:isMonthly?`${selectedYear()}년 ${selectedMonth()}월 ${key}`:key,amount:isMonthly?monthlyBudgetValue(key):num(state.budgets[key]),memo:budgetMemoValue(key),set:(amount,memo)=>{ if(isMonthly){ setMonthlyBudgetForYear(key,amount,selectedYear(),getPeriod().key); } else state.budgets[key]=amount; setBudgetMemoValue(key,memo); state.budgetRevision=num(state.budgetRevision)+1; saveActiveYearSnapshot(); recalculateJaturi(); renderBudget(); renderHome();}}; }
  if(type==='cash'){ const item=state.assets.cashItems[num(key)]; return item&&{title:item.name||'현금',amount:num(item.amount),memo:item.memo||'',set:(amount,memo)=>{item.amount=amount;item.memo=memo;renderAssets();}}; }
  if(type==='purpose'){ const item=state.assets.purposeItems?.[num(key)]; return item&&{title:item.name||'기타 자산',amount:num(item.amount),memo:item.memo||'',set:(amount,memo)=>{item.amount=num(amount);item.memo=String(memo||'');renderAssets();}}; }
  if(type==='invest'){ const item=state.investmentSummary[key]; const names={domestic:'국내주식',overseas:'해외주식',cma:'CMA'}; return item&&{title:names[key]||key,amount:key==='cma'?cmaAmountForPeriod():num(item.amount),memo:item.memo||'',set:(amount,memo)=>{ if(key==='cma'){ item.manualAmount=num(amount); item.amount=num(amount); } else item.amount=amount; item.memo=memo; renderInvest();}}; }
}
function openMoneyMemoEditor(type,key){
  const target=moneyMemoTarget(type,key); if(!target) return;
  activeMoneyMemo={type,key};
  $('#fixedMemoTitle').textContent=target.title+' 메모';
  $('#fixedMemoAmount').value=comma(target.amount);
  $('#fixedMemoEditor').value=target.memo;
  $('#fixedMemoModal').classList.add('open'); $('#fixedMemoModal').setAttribute('aria-hidden','false');
  setTimeout(()=>$('#fixedMemoAmount')?.focus(),50);
}
function closeFixedMemoEditor(){ activeMoneyMemo=null; $('#fixedMemoModal')?.classList.remove('open'); $('#fixedMemoModal')?.setAttribute('aria-hidden','true'); }
function saveFixedMemoEditor(){
  if(!activeMoneyMemo) return;
  const target=moneyMemoTarget(activeMoneyMemo.type,activeMoneyMemo.key); if(!target) return closeFixedMemoEditor();
  target.set(num($('#fixedMemoAmount')?.value),$('#fixedMemoEditor')?.value.trim()||'');
  closeFixedMemoEditor();
  persistRemote();
}

function moveArrayItem(list,from,to){ if(from===to||from<0||to<0) return false; const [item]=list.splice(from,1); list.splice(to,0,item); return true; }
function setupLongPressReorder(){
  let timer=null, active=null, moved=false, startX=0, startY=0;
  const clear=()=>{ if(timer){clearTimeout(timer);timer=null;} };
  document.addEventListener('pointerdown',e=>{
    const row=e.target.closest('[data-reorder-row]');
    if(!row || e.target.closest('button,select,textarea')) return;
    startX=e.clientX; startY=e.clientY; moved=false;
    timer=setTimeout(()=>{ active=row; row.classList.add('reorder-active'); if(navigator.vibrate) navigator.vibrate(35); showToast('누른 채 위아래로 이동해 순서를 변경하세요.'); },520);
  });
  document.addEventListener('pointermove',e=>{
    if(!active){ if(Math.hypot(e.clientX-startX,e.clientY-startY)>10) clear(); return; }
    e.preventDefault();
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-reorder-row]');
    if(!target || target===active || target.dataset.reorderRow!==active.dataset.reorderRow) return;
    const type=active.dataset.reorderRow;
    if(type==='fixed'){
      const from=state.fixedMaster.findIndex(x=>String(x.id)===String(active.dataset.fixedId));
      const to=state.fixedMaster.findIndex(x=>String(x.id)===String(target.dataset.fixedId));
      if(moveArrayItem(state.fixedMaster,from,to)){ moved=true; renderFixed(); active=document.querySelector(`[data-reorder-row="fixed"][data-fixed-id="${CSS.escape(String(state.fixedMaster[to].id))}"]`); active?.classList.add('reorder-active'); }
    } else if(type==='budget'){
      const order=orderedBudgetCategories();
      const from=order.indexOf(active.dataset.budgetCategory), to=order.indexOf(target.dataset.budgetCategory);
      if(moveArrayItem(order,from,to)){ state.budgetOrder=order; moved=true; renderBudget(); active=document.querySelector(`[data-reorder-row="budget"][data-budget-category="${CSS.escape(String(order[to]))}"]`); active?.classList.add('reorder-active'); }
    }
  },{passive:false});
  document.addEventListener('pointerup',async()=>{ clear(); if(active){ active.classList.remove('reorder-active'); active=null; if(moved){ await persistRemote(); showToast('순서를 저장했습니다.'); } } });
  document.addEventListener('pointercancel',()=>{ clear(); active?.classList.remove('reorder-active'); active=null; });
}

function bindEvents(){
  $$('.bottom-nav button').forEach(btn=>btn.addEventListener('click',()=>{ $$('.bottom-nav button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); $$('.view').forEach(v=>v.classList.remove('active')); $(`#view-${btn.dataset.view}`).classList.add('active'); }));
  $('#expenseFormToggle')?.addEventListener('click',()=>setExpenseFormOpen($('#expenseFormWrap')?.hidden));
  $('#prevYear')?.addEventListener('click',async()=>{ await switchYear(selectedYear()-1); });
  $('#nextYear')?.addEventListener('click',async()=>{ await switchYear(selectedYear()+1); });
  $('#prevMonth')?.addEventListener('click',async()=>{ await switchMonth(selectedMonth()-1); });
  $('#nextMonth')?.addEventListener('click',async()=>{ await switchMonth(selectedMonth()+1); });
  document.addEventListener('input', e=>{ const inp=e.target.closest('input[data-money]'); if(!inp) return; const raw=String(inp.value||'').replace(/[^0-9-]/g,''); inp.value=comma(raw); });
  document.addEventListener('click', async e=>{
    const shoppingToggle=e.target.closest('[data-shopping-toggle]');
    if(shoppingToggle){ state.ui.shoppingDetailOpen=!state.ui.shoppingDetailOpen; renderHome(); return; }
    const memoCell=e.target.closest('[data-fixed-memo-open],[data-money-memo-type]');
    if(memoCell){ openMoneyMemoEditor(memoCell.dataset.moneyMemoType||'fixed', memoCell.dataset.moneyMemoKey ?? memoCell.dataset.fixedMemoOpen); return; }
    const paidCheck=e.target.closest('[data-exp-paid]');
    if(paidCheck){ const item=state.expenses.find(x=>x.id===paidCheck.dataset.expPaid); if(item){ item.paid=Boolean(paidCheck.checked); item.updatedAt=new Date().toISOString(); renderLedger(); await persistRemote(); } return; }
    const t=e.target.closest('button'); if(!t) return;
    if(t.dataset.acc){ const key=t.dataset.acc; state.ui.openAccordions[key]=!state.ui.openAccordions[key]; render(); }
    if(t.id==='cashChip'){ $('#cashDetailHome').classList.toggle('hidden'); }
    if(t.dataset.editExp){ const item=state.expenses.find(x=>x.id===t.dataset.editExp); if(item){ $('#expenseId').value=item.id; $('#expenseDate').value=item.date; $('#expensePayer').value=item.payer; $('#expenseCategory').value=item.category; $('#expenseAmount').value=comma(item.amount); $('#expenseMemo').value=item.memo||''; document.querySelector('[data-view="ledger"]').click(); setExpenseFormOpen(true); window.scrollTo({top:0,behavior:'smooth'}); }}
    if(t.dataset.delExp){ if(confirm('이 지출내역을 삭제하시겠습니까?')){ state.expenses=state.expenses.filter(x=>x.id!==t.dataset.delExp); await persistRemote(); }}
    if(t.id==='addFixedBtn'){ state.fixedMaster.push({id:crypto.randomUUID(),name:'',owner:'공동',category:'기타',memo:'',monthly:{}}); renderFixed(); }
    if(t.dataset.fixedMemoToggle!==undefined){ const wrap=document.querySelector(`[data-fixed-memo-wrap="${t.dataset.fixedMemoToggle}"]`); if(wrap) wrap.classList.toggle('hidden'); }
    if(t.dataset.fixedDel!==undefined){ if(confirm('이 고정지출 항목과 월별 금액·메모를 모두 삭제하시겠습니까?')){ const idx=num(t.dataset.fixedDel); const item=state.fixedMaster[idx]; if(item?.id){ state.fixedDeletedIds=Array.isArray(state.fixedDeletedIds)?state.fixedDeletedIds:[]; if(!state.fixedDeletedIds.includes(String(item.id))) state.fixedDeletedIds.push(String(item.id)); } state.fixedMaster.splice(idx,1); renderFixed(); await persistRemote(); showToast('고정지출 항목을 삭제했습니다.'); } }
    if(t.dataset.fixedFreeze!==undefined){
      const item=(state.fixedMaster||[]).find(f=>String(f?.id||'')===String(t.dataset.fixedFreeze||''));
      if(!item){ showToast('고정지출 항목을 찾을 수 없습니다.'); return; }
      const currentYear=selectedYear(), currentMonth=selectedMonth();
      const prevYear=currentMonth===1?currentYear-1:currentYear;
      const prevMonth=currentMonth===1?12:currentMonth-1;
      const currentKey=`${currentYear}-${String(currentMonth).padStart(2,'0')}`;
      const prevKey=`${prevYear}-${String(prevMonth).padStart(2,'0')}`;
      const prev=fixedMonthValue(item,prevKey);
      const hasPrevious=Object.values(prev.amounts||{}).some(v=>num(v)!==0) || Object.values(prev.memos||{}).some(v=>String(v||'').trim());
      if(!hasPrevious){ alert(`${prevYear}년 ${prevMonth}월에 복사할 금액이나 메모가 없습니다.`); return; }
      const current=fixedMonthValue(item,currentKey);
      const hasCurrent=Object.values(current.amounts||{}).some(v=>num(v)!==0) || Object.values(current.memos||{}).some(v=>String(v||'').trim());
      if(hasCurrent && !confirm(`${currentYear}년 ${currentMonth}월의 기존 금액과 메모를 전달 내용으로 덮어쓰시겠습니까?`)) return;
      const copiedAmounts={공동:num(prev.amounts?.공동),진혁:num(prev.amounts?.진혁),다혜:num(prev.amounts?.다혜)};
      const copiedMemos={공동:String(prev.memos?.공동||''),진혁:String(prev.memos?.진혁||''),다혜:String(prev.memos?.다혜||'')};
      item.monthly=item.monthly||{};
      item.monthly[currentKey]={
        ...(item.monthly[currentKey]||{}),
        amounts:copiedAmounts,
        memos:copiedMemos,
        amount:Object.values(copiedAmounts).reduce((sum,v)=>sum+num(v),0),
        budget:Object.values(copiedAmounts).reduce((sum,v)=>sum+num(v),0),
        memo:Object.values(copiedMemos).filter(Boolean).join(' '),
        frozenFrom:prevKey,
        frozenAt:new Date().toISOString()
      };
      item.category=fixedCategory(item,currentKey);
      item.updatedAt=new Date().toISOString();
      recalculateJaturi();
      await persistRemote();
      showToast(`${prevMonth}월 금액과 메모를 ${currentMonth}월에 동결 적용했습니다.`);
    }
    if(t.id==='addCashItemBtn'){ state.assets.cashItems.push({id:crypto.randomUUID(),name:'',amount:0,memo:''}); renderAssets(); }
    if(t.dataset.cashDel!==undefined){ state.assets.cashItems.splice(num(t.dataset.cashDel),1); renderAssets(); await persistRemote(); }
  });
  $('#expenseDate').value=defaultExpenseDateForSelection();
  $('#expenseForm').addEventListener('submit', async e=>{ e.preventDefault(); const id=$('#expenseId').value||crypto.randomUUID(); const idx=state.expenses.findIndex(x=>x.id===id); const item={id,date:$('#expenseDate').value,payer:$('#expensePayer').value,category:$('#expenseCategory').value,amount:num($('#expenseAmount').value),memo:$('#expenseMemo').value.trim(),paid:idx>=0?Boolean(state.expenses[idx]?.paid):false,updatedAt:new Date().toISOString()}; if(idx>=0) state.expenses[idx]=item; else state.expenses.push(item); clearExpenseForm(); setExpenseFormOpen(true); await persistRemote(); });
  $('#expenseCancel').addEventListener('click', ()=>{ clearExpenseForm(); setExpenseFormOpen(false); });
  $('#saveBudgetBtn').addEventListener('click', async()=>{ const entries=[]; $$('[data-budget-add]').forEach(inp=>{ const amount=num(inp.value); if(amount) entries.push({category:inp.dataset.budgetAdd,type:'추가',amount}); inp.value=''; }); $$('[data-budget-cut]').forEach(inp=>{ const amount=num(inp.value); if(amount) entries.push({category:inp.dataset.budgetCut,type:'삭감',amount}); inp.value=''; }); let changed=false; state.budgetAdjustments=Array.isArray(state.budgetAdjustments)?state.budgetAdjustments:[]; for(const entry of entries){ changed=true; const c=entry.category, delta=entry.type==='추가'?entry.amount:-entry.amount; if(MONTHLY_CATEGORIES.includes(c)){ const pk=getPeriod().key; setMonthlyBudgetForYear(c,Math.max(0,monthlyBudgetValue(c,pk)+delta),selectedYear(),pk); } else state.budgets[c]=Math.max(0,num(state.budgets[c])+delta); const reason=prompt(`${c} ${entry.type} ${comma(entry.amount)}원 사유를 입력하세요.`,budgetMemoValue(c)) ?? ''; state.budgetAdjustments.push({id:crypto.randomUUID(),category:c,type:entry.type,amount:entry.amount,reason:String(reason).trim(),scope:MONTHLY_CATEGORIES.includes(c)?'monthly':'yearly',periodKey:MONTHLY_CATEGORIES.includes(c)?getPeriod().key:'',year:selectedYear(),createdAt:new Date().toISOString()}); } if(changed){ state.budgetRevision=num(state.budgetRevision)+1; saveActiveYearSnapshot(); } recalculateJaturi(); await persistRemote(); renderBudget(); showToast('예산의 추가·삭감 금액을 반영했습니다.'); });
  $('#fixedList').addEventListener('input', e=>{ const pk=getPeriod().key, i=num(e.target.dataset.fixedName); const item=state.fixedMaster[i]; if(!item) return; if(e.target.dataset.fixedName!==undefined){ item.name=e.target.value; item.category=fixedCategory(item,pk); } item.updatedAt=new Date().toISOString(); });
  $('#saveFixedBtn')?.addEventListener('click', async()=>{ state.fixedMaster.forEach(f=>f.category=fixedCategory(f,getPeriod().key)); recalculateJaturi(); await persistRemote(); showToast('고정지출과 자동 분류를 저장했습니다.'); });
  $('#fixedMemoSave')?.addEventListener('click', saveFixedMemoEditor);
  $('#fixedMemoCancel')?.addEventListener('click', closeFixedMemoEditor);
  $('#fixedMemoModal')?.addEventListener('click', e=>{ if(e.target.id==='fixedMemoModal') closeFixedMemoEditor(); });
  $('#fixedMemoEditor')?.addEventListener('keydown', e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); saveFixedMemoEditor(); } if(e.key==='Escape') closeFixedMemoEditor(); });
  $('#cashItemList').addEventListener('input', e=>{ const i=num(e.target.dataset.cashName); const arr=state.assets.cashItems; if(e.target.dataset.cashName!==undefined) arr[i].name=e.target.value; });
  $('#cashItemList').addEventListener('change', persistRemote);
  $('#saveJinhyukSalary').addEventListener('click', async()=>{ $$('[data-jinhyuk-month]').forEach(inp=>{ state.salary.jinhyuk[inp.dataset.jinhyukMonth]=num(inp.value); }); await persistRemote(); });
  $('#saveDahyeSalary').addEventListener('click', async()=>{ const d=state.salary.dahye; d.base=num($('#dahyeBase').value); d.rates={weekday:num($('#rateWeekday').value),holiday:num($('#rateHoliday').value),sunday:num($('#rateSunday').value),monThu:num($('#rateMonThu').value),friday:num($('#rateFriday').value)}; d.tax={...(d.tax||{}),pensionAmount:num($('#taxPension').value),taxHealthRate:num($('#taxHealth').value),taxCareRate:num($('#taxCare').value),taxEmploymentRate:num($('#taxEmployment').value),incomeTax:num($('#taxIncome').value),taxLocal:num($('#taxLocal').value),otherDeduct:num($('#taxOther').value),vehicleAllowance:num($('#taxVehicle').value),memoDeduct:num($('#taxMemoDeduct').value)}; $$('[data-duty-month]').forEach(inp=>{ const m=inp.dataset.dutyMonth,k=inp.dataset.dutyKey; d.months[m]=d.months[m]||{}; d.months[m][k]=num(inp.value); }); $$('[data-bonus-month]').forEach(inp=>{ const m=inp.dataset.bonusMonth; d.months[m]=d.months[m]||{}; d.months[m].bonus=num(inp.value); }); $$('[data-tax-month]').forEach(inp=>{ const m=inp.dataset.taxMonth,k=inp.dataset.taxKey; d.months[m]=d.months[m]||{}; d.months[m][k]=num(inp.value); }); await persistRemote(); });
  $('#saveCashAssetsBtn')?.addEventListener('click', async()=>{ await persistRemote(); showToast('현금 세부분류를 저장했습니다.'); });
  $('#addPurposeItemBtn')?.addEventListener('click', async()=>{
    const name=prompt('추가할 기타 자산 항목명을 입력하세요.','');
    if(name===null) return;
    const clean=name.trim();
    if(!clean){ alert('항목명을 입력해주세요.'); return; }
    state.assets.purposeItems=state.assets.purposeItems||[];
    state.assets.purposeItems.push({id:crypto.randomUUID(),name:clean,amount:0,memo:''});
    renderAssets();
    await persistRemote();
    showToast('기타 자산 항목을 추가했습니다.');
  });
  $('#assetInputTable').addEventListener('click', async e=>{
    const edit=e.target.closest('[data-purpose-edit]');
    if(edit){
      const i=num(edit.dataset.purposeEdit), item=state.assets.purposeItems?.[i]; if(!item) return;
      const name=prompt('기타 자산 항목명을 수정하세요.',item.name||'');
      if(name===null) return;
      const clean=name.trim(); if(!clean){ alert('항목명을 입력해주세요.'); return; }
      item.name=clean; renderAssets(); await persistRemote(); return;
    }
    const del=e.target.closest('[data-purpose-del]');
    if(del){
      const i=num(del.dataset.purposeDel), item=state.assets.purposeItems?.[i]; if(!item) return;
      if(!confirm(`“${item.name||'기타 자산'}” 항목을 삭제하시겠습니까?`)) return;
      state.otherAssetDeletedIds=state.otherAssetDeletedIds||[];
      if(item.id && !state.otherAssetDeletedIds.includes(String(item.id))) state.otherAssetDeletedIds.push(String(item.id));
      state.assets.purposeItems.splice(i,1);
      persistLocal();
      renderAssets();
      await persistRemote();
      showToast('기타 자산 항목을 삭제했습니다.');
    }
  });
  $('#investmentTable').addEventListener('input', e=>{ const key=e.target.dataset.investRate; if(key!==undefined){ state.investmentSummary[key].rate=num(e.target.value); const avg=$('#investmentAverageRate'); if(avg) avg.textContent=investmentAverageRate().toFixed(2)+'%'; } });
  $('#saveAssetsBtn').addEventListener('click', async()=>{ await persistRemote(); });
  $('#saveInvestBtn').addEventListener('click', async()=>{ ['domestic','overseas'].forEach(k=>{ state.investmentSummary[k].rate=num($(`[data-invest-rate="${k}"]`)?.value); }); await persistRemote(); });
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
  $('#loginForm')?.addEventListener('submit', async e=>{
    e.preventDefault();
    const btn=$('#loginBtn'), err=$('#loginError');
    if(btn){ btn.disabled=true; btn.textContent='로그인 중...'; }
    if(err) err.textContent='';
    try{
      const cfg=parseFirebaseConfig(state.settings.firebaseConfigText || DEFAULT_FIREBASE_CONFIG);
      await initFirebase(cfg); ensureAuthObserver();
      await loginWithEmail($('#loginEmail').value, $('#loginPassword').value);
      $('#loginPassword').value='';
      setAuthGate(false);
      await connectFirebase();
    }catch(ex){ console.error(ex); if(err) err.textContent=ex.code==='auth/invalid-credential'?'이메일 또는 비밀번호가 맞지 않습니다.':('로그인 실패: '+ex.message); }
    finally{ if(btn){ btn.disabled=false; btn.textContent='로그인'; } }
  });
  $('#logoutBtn')?.addEventListener('click', async()=>{
    if(!confirm('로그아웃하시겠습니까? 공동 동기화가 중지됩니다.')) return;
    try{ await logoutFirebase(); firebaseReady=false; remoteLoaded=false; setBadge('로그인 필요','off'); setAuthGate(true); }
    catch(ex){ alert('로그아웃 실패: '+ex.message); }
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
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&firebaseReady) refreshFromFirebase(false); });
  window.addEventListener('focus',()=>{ if(firebaseReady) refreshFromFirebase(false); });
}

saveLocalViewPeriod(selectedYear(), selectedMonth());
applyYearBucket(selectedYear());
bindEvents(); setupLongPressReorder();
  setupPullToRefresh(); render();
try{
  const sync=JSON.parse(localStorage.getItem('hzzdzz_sync_settings')||'null');
  const savedConfig = sync?.firebaseConfigText || state.settings?.firebaseConfigText;
  if(savedConfig || DEFAULT_FIREBASE_CONFIG){
    state.settings={...state.settings,...(sync||{}), firebaseConfigText:savedConfig||''};
    persistLocal();
    connectFirebase();
  } else setBadge('오프라인','off');
} catch { setBadge('오프라인','off'); }
