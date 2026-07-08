import { parseFirebaseConfig, initFirebase, subscribeHousehold, saveHousehold, fetchHousehold } from './firebase.js';

const APP_VERSION = '0.8.3';
const DEFAULT_HOUSEHOLD = 'hzzdzz_가계부';
const MONTHLY_CATEGORIES = ['식비'];
const YEARLY_CATEGORIES = ['생필품','비상금','쇼핑비','부모님','경조사비','육아'];
const EXPENSE_CATEGORIES = [...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES];
const ASSET_CATEGORIES = ['현금','은행','국내주식','해외주식','CMA','연금','청약','코인','여행비','기타'];
const INVEST_TYPES = ['국내주식','해외주식','CMA'];
const DEFAULT_RATES = {weekday:77330, holiday:284470, sunday:163640, monThu:10000, friday:20000};
const DEFAULT_TAX = {pension:215220, incomeTax:58750, vehicleAllowance:0, memoDeduct:0};

let state = loadLocalState();
let firebaseReady = false;
let syncingRemote = false;
let refreshing = false;
let remoteLoaded = false; // Firebase의 기존 데이터를 한 번 읽기 전에는 절대 저장하지 않음

function defaultState(){
  return {
    appVersion: APP_VERSION,
    settings: { cycleStartDay: 10, householdId: DEFAULT_HOUSEHOLD, firebaseConfigText: '' },
    budgets: Object.fromEntries([...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES].map(c=>[c,0])),
    expenses: [],
    fixedByMonth: {},
    salary: {
      jinhyuk: {},
      dahye: { base:0, rates:{...DEFAULT_RATES}, tax:{...DEFAULT_TAX}, months:{} }
    },
    assets: Object.fromEntries(ASSET_CATEGORIES.map(c=>[c,0])),
    investments: [],
    jaturi: { balance:0, history:[] }
  };
}
function mergeDefaults(data){
  const base = defaultState();
  const merged = {...base, ...(data||{})};
  merged.settings = {...base.settings, ...(data?.settings||{})};
  merged.budgets = {...base.budgets, ...(data?.budgets||{})};
  merged.fixedByMonth = {...base.fixedByMonth, ...(data?.fixedByMonth||{})};
  merged.salary = {...base.salary, ...(data?.salary||{})};
  merged.salary.dahye = {...base.salary.dahye, ...(data?.salary?.dahye||{})};
  merged.salary.dahye.rates = {...base.salary.dahye.rates, ...(data?.salary?.dahye?.rates||{})};
  merged.salary.dahye.tax = {...base.salary.dahye.tax, ...(data?.salary?.dahye?.tax||{})};
  merged.salary.dahye.months = {...base.salary.dahye.months, ...(data?.salary?.dahye?.months||{})};
  merged.salary.jinhyuk = {...base.salary.jinhyuk, ...(data?.salary?.jinhyuk||{})};
  merged.assets = {...base.assets, ...(data?.assets||{})};
  merged.expenses = Array.isArray(data?.expenses) ? data.expenses : [];
  merged.investments = Array.isArray(data?.investments) ? data.investments : [];
  merged.jaturi = {...base.jaturi, ...(data?.jaturi||{})};
  return merged;
}
function loadLocalState(){
  try { return mergeDefaults(JSON.parse(localStorage.getItem('hzzdzz_state_v08') || 'null')); }
  catch { return defaultState(); }
}
function persistLocal(){
  localStorage.setItem('hzzdzz_state_v08', JSON.stringify(state));
  localStorage.setItem('hzzdzz_sync_settings', JSON.stringify(state.settings));
}
async function persistRemote(){
  persistLocal();
  render();
  if(firebaseReady && !syncingRemote){
    if(!remoteLoaded){
      console.warn('Firebase 기존 데이터 확인 전 저장 차단: 데이터 덮어쓰기 방지');
      setBadge('동기화 확인 중','loading');
      return;
    }
    try { await saveHousehold(stripRuntime(state)); setBadge('공동 동기화','on'); }
    catch(e){ console.error(e); setBadge('저장 오류','off'); alert('Firebase 저장 오류: '+e.message); }
  }
}
function stripRuntime(s){
  const copy = JSON.parse(JSON.stringify(s));
  delete copy.updatedAt;
  return copy;
}

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const money = n => `${Math.round(Number(n)||0).toLocaleString('ko-KR')}원`;
const num = v => Number(String(v ?? '').replace(/,/g,'')) || 0;
const ymd = d => d.toISOString().slice(0,10);
const now = new Date();

function getPeriod(date = new Date()){
  const startDay = Math.min(Math.max(num(state.settings.cycleStartDay)||10,1),28);
  let y = date.getFullYear();
  let m = date.getMonth();
  if(date.getDate() < startDay) m -= 1;
  const start = new Date(y, m, startDay);
  const end = new Date(y, m+1, startDay-1);
  const key = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}`;
  return {start, end, key, label:`${start.getFullYear()}년 ${start.getMonth()+1}월 (${start.getMonth()+1}/${startDay}~${end.getMonth()+1}/${end.getDate()})`};
}
function inPeriod(dateStr){
  const p = getPeriod();
  const d = new Date(dateStr+'T00:00:00');
  return d >= new Date(p.start.toDateString()) && d <= new Date(p.end.toDateString());
}
function currentExpenses(){ return state.expenses.filter(e=>inPeriod(e.date)); }
function catSpent(cat){ return currentExpenses().filter(e=>e.category===cat).reduce((a,e)=>a+num(e.amount),0); }
function currentFixed(){ return state.fixedByMonth[getPeriod().key] || []; }
function fixedTotal(){ return currentFixed().reduce((a,f)=>a+num(f.amount),0); }
function currentJinhyukSalary(){ return num(state.salary.jinhyuk[getPeriod().key]); }
function currentDahyeSalary(){ return calcDahyeMonth(getPeriod().start.getMonth()+1).net; }
function totalBudgetSpent(){ return EXPENSE_CATEGORIES.reduce((a,c)=>a+catSpent(c),0); }
function totalAssets(){
  const base = Object.entries(state.assets).reduce((a,[k,v])=>a+(['국내주식','해외주식','CMA'].includes(k)?0:num(v)),0);
  return base + investTotals().current;
}
function investTotals(){
  return state.investments.reduce((a,it)=>{a.principal+=num(it.principal);a.current+=num(it.current);return a;},{principal:0,current:0});
}
function excelRoundDown(value, digits){
  const factor = Math.pow(10, -digits);
  return Math.trunc((Number(value)||0) / factor) * factor;
}
function calcDahyeMonth(month){
  const d = state.salary.dahye;
  const r = d.rates || DEFAULT_RATES;
  const t = {...DEFAULT_TAX, ...(d.tax||{})};
  const m = d.months?.[month] || {};

  // 월급 엑셀 기준: 기본급 + 당직수당 + 기타수당 = 기본급+과세합계(F열)
  const duty = num(m.weekday)*num(r.weekday)
    + num(m.holiday)*num(r.holiday)
    + num(m.sunday)*num(r.sunday)
    + num(m.monThu)*num(r.monThu)
    + num(m.friday)*num(r.friday);
  const taxablePay = num(d.base) + duty + num(m.extraAllowance);
  const paymentTotal = taxablePay + num(t.vehicleAllowance);

  // 월급.xlsx Sheet1 수식 검토 반영
  // F=SUM(B:E), H=SUM(F:G), J=F*3.595%, K=ROUNDDOWN(J*13.14%,-1),
  // L=ROUNDDOWN(F*0.9%,-1), N=ROUNDDOWN(M*10%,-1), O=SUM(I:N), P=H-O, Q=P-C
  // 국민연금(I열)과 소득세(M열)는 엑셀에서 수식이 아닌 입력값이므로 기준값을 사용자가 조정합니다.
  const pension = num(t.pension);
  const health = taxablePay * 0.03595;
  const care = excelRoundDown(health * 0.1314, -1);
  const employment = excelRoundDown(taxablePay * 0.009, -1);
  const incomeTax = num(t.incomeTax);
  const localTax = excelRoundDown(incomeTax * 0.10, -1);
  const deductions = pension + health + care + employment + incomeTax + localTax;
  const netBeforeMemo = paymentTotal - deductions;
  const net = netBeforeMemo - num(t.memoDeduct);
  return {duty, taxablePay, paymentTotal, pension, health, care, employment, incomeTax, localTax, deductions, net: Math.round(net)};
}
function setBadge(text, cls){ const el=$('#syncBadge'); el.textContent=text; el.className='badge '+cls; }
function formatSyncTime(date=new Date()){
  return date.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function updateLastSyncLabel(){
  const saved = localStorage.getItem('hzzdzz_last_sync_at');
  const el = $('#lastSyncLabel');
  if(el) el.textContent = saved ? `마지막 업데이트 ${formatSyncTime(new Date(saved))}` : '마지막 업데이트 -';
}
function markSynced(){
  localStorage.setItem('hzzdzz_last_sync_at', new Date().toISOString());
  updateLastSyncLabel();
}
function showToast(message){
  const el = $('#toast');
  if(!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>el.classList.remove('show'), 1800);
}

function render(){
  const p=getPeriod();
  $('#periodLabel').textContent=p.label;
  renderHome(); renderLedger(); renderBudget(); renderSalary(); renderAssets(); renderInvest(); renderSettings(); updateLastSyncLabel();
}
function renderHome(){
  const invest = investTotals();
  const assetValues = {...state.assets, 국내주식:0, 해외주식:0, CMA:0};
  state.investments.forEach(it=>{ if(assetValues[it.type]!==undefined) assetValues[it.type]+=num(it.current); });
  $('#assetSummaryGrid').innerHTML = ASSET_CATEGORIES.map(c=>`<div class="asset-chip"><span>${c}</span><strong>${money(assetValues[c])}</strong></div>`).join('');
  $('#homeTotalAssets').textContent = money(totalAssets());

  const j = currentJinhyukSalary(); const d = currentDahyeSalary(); const income=j+d; const fixed=fixedTotal(); const spent=totalBudgetSpent(); const surplus=income-fixed-spent;
  $('#homeJinhyukSalary').textContent=money(j); $('#homeDahyeSalary').textContent=money(d); $('#homeIncome').textContent=money(income); $('#homeFixed').textContent=money(fixed); $('#homeBudgetSpent').textContent=money(spent); $('#homeSurplus').textContent=money(surplus);
  $('#homeSurplus').className = surplus>=0 ? 'plus' : 'minus';

  const tbody=$('#homeBudgetTable tbody');
  tbody.innerHTML = [...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES].map(c=>{
    const budget=num(state.budgets[c]); const spent=catSpent(c); const bal=budget-spent; const type=MONTHLY_CATEGORIES.includes(c)?'월':'연';
    return `<tr><td>${c}</td><td>${type}예산</td><td>${money(budget)}</td><td>${money(spent)}</td><td class="${bal<0?'minus':'plus'}">${money(bal)}</td></tr>`;
  }).join('');
  $('#jaturiBalance').textContent=money(num(state.jaturi.balance));

  const ex=currentExpenses(); const total=ex.reduce((a,e)=>a+num(e.amount),0); const jin=ex.filter(e=>e.payer==='진혁').reduce((a,e)=>a+num(e.amount),0); const dah=ex.filter(e=>e.payer==='다혜').reduce((a,e)=>a+num(e.amount),0); const half=total/2;
  $('#settleTotal').textContent=money(total); $('#settleJinhyuk').textContent=money(jin); $('#settleDahye').textContent=money(dah); $('#settleHalf').textContent=money(half);
  let result='정산 없음'; if(jin>half) result=`다혜 → 진혁 ${money(jin-half)}`; else if(dah>half) result=`진혁 → 다혜 ${money(dah-half)}`;
  $('#settleResult').textContent=result;
}
function renderLedger(){
  const sel=$('#expenseCategory'); if(sel.options.length===0) sel.innerHTML=EXPENSE_CATEGORIES.map(c=>`<option>${c}</option>`).join('');
  const rows=currentExpenses().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  $('#ledgerTable tbody').innerHTML = rows.map(e=>`<tr><td>${e.date||''}</td><td>${escapeHtml(e.memo||'')}</td><td>${e.category}</td><td>${e.payer}</td><td>${money(e.amount)}</td><td><button class="ghost small" data-edit-exp="${e.id}">수정</button> <button class="danger small" data-del-exp="${e.id}">삭제</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">이번 월 지출내역이 없습니다.</td></tr>';
}
function renderBudget(){
  $('#budgetInputTable tbody').innerHTML = [...MONTHLY_CATEGORIES, ...YEARLY_CATEGORIES].map(c=>`<tr><td>${c}</td><td>${MONTHLY_CATEGORIES.includes(c)?'월예산':'연예산'}</td><td><input data-budget="${c}" type="number" value="${num(state.budgets[c])}"></td></tr>`).join('');
  const key=getPeriod().key;
  const list=currentFixed();
  $('#fixedList').innerHTML = list.map((f,i)=>`<div class="fixed-row"><input placeholder="항목" data-fixed-name="${i}" value="${escapeAttr(f.name||'')}"><input type="number" placeholder="금액" data-fixed-amount="${i}" value="${num(f.amount)}"><button class="danger" data-fixed-del="${i}">삭제</button></div>`).join('') || '<p class="hint">이번 월 고정지출이 없습니다.</p>';
}
function renderSalary(){
  $('#jinhyukSalary').value = currentJinhyukSalary() || '';
  const d=state.salary.dahye;
  const tax={...DEFAULT_TAX, ...(d.tax||{})};
  $('#dahyeBase').value=num(d.base)||''; $('#rateWeekday').value=num(d.rates.weekday); $('#rateHoliday').value=num(d.rates.holiday); $('#rateSunday').value=num(d.rates.sunday); $('#rateMonThu').value=num(d.rates.monThu); $('#rateFriday').value=num(d.rates.friday);
  $('#taxPension').value=num(tax.pension)||''; $('#taxIncome').value=num(tax.incomeTax)||''; $('#taxVehicle').value=num(tax.vehicleAllowance)||''; $('#taxMemoDeduct').value=num(tax.memoDeduct)||'';
  $('#dahyeDutyTable tbody').innerHTML = Array.from({length:12},(_,i)=>i+1).map(m=>{
    const v=d.months[m]||{}; const calc=calcDahyeMonth(m);
    return `<tr><td>${m}월 : 당직비</td><td><input data-duty-month="${m}" data-duty-key="weekday" type="number" value="${num(v.weekday)||''}"></td><td><input data-duty-month="${m}" data-duty-key="holiday" type="number" value="${num(v.holiday)||''}"></td><td><input data-duty-month="${m}" data-duty-key="sunday" type="number" value="${num(v.sunday)||''}"></td><td><input data-duty-month="${m}" data-duty-key="monThu" type="number" value="${num(v.monThu)||''}"></td><td><input data-duty-month="${m}" data-duty-key="friday" type="number" value="${num(v.friday)||''}"></td><td>${money(calc.duty)}</td><td>${money(calc.taxablePay)}</td><td>${money(calc.pension)}</td><td>${money(calc.health)}</td><td>${money(calc.care)}</td><td>${money(calc.employment)}</td><td>${money(calc.incomeTax)}</td><td>${money(calc.localTax)}</td><td>${money(calc.deductions)}</td><td>${money(calc.net)}</td></tr>`;
  }).join('');
}
function renderAssets(){
  $('#assetInputTable tbody').innerHTML = ASSET_CATEGORIES.map(c=>`<tr><td>${c}</td><td><input data-asset="${c}" type="number" value="${num(state.assets[c])}"></td></tr>`).join('');
}
function renderInvest(){
  $('#investmentTable tbody').innerHTML = state.investments.map((it,i)=>{
    const profit=num(it.current)-num(it.principal); const rate=num(it.principal)?(profit/num(it.principal)*100):0;
    return `<tr><td><select data-invest-type="${i}">${INVEST_TYPES.map(t=>`<option ${it.type===t?'selected':''}>${t}</option>`).join('')}</select></td><td><input data-invest-name="${i}" value="${escapeAttr(it.name||'')}"></td><td><input data-invest-principal="${i}" type="number" value="${num(it.principal)}"></td><td><input data-invest-current="${i}" type="number" value="${num(it.current)}"></td><td class="${profit>=0?'plus':'minus'}">${money(profit)}</td><td class="${rate>=0?'plus':'minus'}">${rate.toFixed(1)}%</td><td><button class="danger" data-invest-del="${i}">삭제</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">투자 항목이 없습니다.</td></tr>';
}
function renderSettings(){
  $('#firebaseConfigText').value = state.settings.firebaseConfigText || '';
  $('#householdId').value = state.settings.householdId || DEFAULT_HOUSEHOLD;
  $('#cycleStartDay').value = state.settings.cycleStartDay || 10;
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(s){ return escapeHtml(s).replace(/`/g,'&#96;'); }

async function refreshFromFirebase(showDone=true){
  if(refreshing) return;
  if(!firebaseReady){
    const sync=JSON.parse(localStorage.getItem('hzzdzz_sync_settings')||'null');
    if(sync?.firebaseConfigText){
      state.settings={...state.settings,...sync};
      await connectFirebase();
      return;
    }
    showToast('공동 동기화 설정이 필요합니다.');
    return;
  }
  try{
    refreshing = true;
    setBadge('새로고침 중','loading');
    setPullStatus('동기화 중...');
    const remote = await fetchHousehold();
    if(remote){
      // Firebase 데이터를 기준으로 병합합니다. 프로그램 업데이트 후 로컬 기본값이 기존 데이터를 덮지 않도록 합니다.
      state = mergeDefaults({...state, ...remote, settings:{...state.settings, ...(remote.settings||{})}});
      remoteLoaded = true;
      persistLocal();
      render();
    }
    markSynced();
    setBadge('공동 동기화','on');
    if(showDone) showToast('최신 데이터로 업데이트되었습니다.');
  } catch(e){
    console.error(e);
    setBadge('새로고침 오류','off');
    showToast('새로고침 실패: '+e.message);
  } finally {
    refreshing = false;
    resetPullIndicator();
  }
}

function setPullStatus(text){
  const el=$('#pullRefresh');
  if(el) el.textContent=text;
}
function resetPullIndicator(){
  const el=$('#pullRefresh');
  if(!el) return;
  el.classList.remove('visible','ready','loading');
  el.style.transform='translate(-50%, -120%)';
  el.textContent='아래로 당겨 새로고침';
}
function setupPullToRefresh(){
  const el=$('#pullRefresh');
  if(!el) return;
  let startY=0;
  let tracking=false;
  let distance=0;
  const threshold=76;
  document.addEventListener('touchstart', e=>{
    if(window.scrollY<=0 && !refreshing){
      startY=e.touches[0].clientY;
      tracking=true;
      distance=0;
    }
  }, {passive:true});
  document.addEventListener('touchmove', e=>{
    if(!tracking || refreshing) return;
    distance=e.touches[0].clientY-startY;
    if(distance<=0) return;
    if(window.scrollY>0){ tracking=false; return; }
    const shown=Math.min(distance*0.55, 92);
    el.classList.add('visible');
    el.classList.toggle('ready', distance>threshold);
    el.textContent = distance>threshold ? '놓으면 새로고침' : '아래로 당겨 새로고침';
    el.style.transform=`translate(-50%, ${shown-120}%)`;
    if(distance>18) e.preventDefault();
  }, {passive:false});
  document.addEventListener('touchend', ()=>{
    if(!tracking) return;
    tracking=false;
    if(distance>threshold){
      el.classList.add('loading');
      el.textContent='동기화 중...';
      el.style.transform='translate(-50%, 8px)';
      refreshFromFirebase(true);
    } else {
      resetPullIndicator();
    }
  }, {passive:true});
}

async function connectFirebase(){
  try{
    setBadge('연결 중','loading');
    state.settings.firebaseConfigText=$('#firebaseConfigText').value.trim();
    state.settings.householdId=$('#householdId').value.trim() || DEFAULT_HOUSEHOLD;
    state.settings.cycleStartDay=num($('#cycleStartDay').value)||10;
    persistLocal();
    const cfg=parseFirebaseConfig(state.settings.firebaseConfigText);
    initFirebase(cfg);
    subscribeHousehold(state.settings.householdId, async remote=>{
      syncingRemote=true;
      if(remote){
        // 기존 Firebase 데이터가 항상 우선입니다.
        // 업데이트된 프로그램의 빈 기본값이 투자/자산/예산 데이터를 덮어쓰지 않도록 합니다.
        state=mergeDefaults({...state, ...remote, settings:{...state.settings, ...(remote.settings||{})}});
        remoteLoaded = true;
      }
      else {
        // 새 가계부일 때만 최초 문서를 생성합니다.
        remoteLoaded = true;
        await saveHousehold(stripRuntime(state));
      }
      syncingRemote=false;
      persistLocal(); render(); markSynced(); setBadge('공동 동기화','on'); firebaseReady=true;
    }, err=>{ console.error(err); setBadge('동기화 오류','off'); alert('동기화 오류: '+err.message); });
  } catch(e){ console.error(e); setBadge('연결 실패','off'); alert(e.message); }
}

function bindEvents(){
  $$('.bottom-nav button').forEach(btn=>btn.addEventListener('click',()=>{
    $$('.bottom-nav button').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    $$('.view').forEach(v=>v.classList.remove('active')); $(`#view-${btn.dataset.view}`).classList.add('active');
  }));
  $('#expenseDate').value=ymd(new Date());
  $('#expenseForm').addEventListener('submit', async e=>{ e.preventDefault(); const id=$('#expenseId').value || crypto.randomUUID(); const item={id,date:$('#expenseDate').value,payer:$('#expensePayer').value,category:$('#expenseCategory').value,amount:num($('#expenseAmount').value),memo:$('#expenseMemo').value.trim(),updatedAt:new Date().toISOString()}; const idx=state.expenses.findIndex(x=>x.id===id); if(idx>=0) state.expenses[idx]=item; else state.expenses.push(item); clearExpenseForm(); await persistRemote(); });
  $('#expenseCancel').addEventListener('click', clearExpenseForm);
  document.addEventListener('click', async e=>{
    const t=e.target;
    if(t.dataset.editExp){ const item=state.expenses.find(x=>x.id===t.dataset.editExp); if(item){ $('#expenseId').value=item.id; $('#expenseDate').value=item.date; $('#expensePayer').value=item.payer; $('#expenseCategory').value=item.category; $('#expenseAmount').value=item.amount; $('#expenseMemo').value=item.memo||''; document.querySelector('[data-view="ledger"]').click(); window.scrollTo({top:0,behavior:'smooth'}); } }
    if(t.dataset.delExp){ if(confirm('이 지출내역을 삭제하시겠습니까?')){ state.expenses=state.expenses.filter(x=>x.id!==t.dataset.delExp); await persistRemote(); } }
    if(t.id==='addFixedBtn'){ const key=getPeriod().key; state.fixedByMonth[key]=currentFixed().concat([{name:'',amount:0}]); renderBudget(); }
    if(t.dataset.fixedDel!==undefined){ const key=getPeriod().key; const arr=currentFixed(); arr.splice(num(t.dataset.fixedDel),1); state.fixedByMonth[key]=arr; await persistRemote(); }
    if(t.id==='addInvestBtn'){ state.investments.push({id:crypto.randomUUID(),type:'국내주식',name:'',principal:0,current:0}); renderInvest(); }
    if(t.dataset.investDel!==undefined){ state.investments.splice(num(t.dataset.investDel),1); await persistRemote(); }
  });
  $('#saveBudgetBtn').addEventListener('click', async()=>{ $$('[data-budget]').forEach(i=>state.budgets[i.dataset.budget]=num(i.value)); await persistRemote(); });
  $('#fixedList').addEventListener('input', e=>{ const key=getPeriod().key; const arr=currentFixed(); const i=num(e.target.dataset.fixedName ?? e.target.dataset.fixedAmount); if(e.target.dataset.fixedName!==undefined) arr[i].name=e.target.value; if(e.target.dataset.fixedAmount!==undefined) arr[i].amount=num(e.target.value); state.fixedByMonth[key]=arr; });
  $('#fixedList').addEventListener('change', persistRemote);
  $('#saveJinhyukSalary').addEventListener('click', async()=>{ state.salary.jinhyuk[getPeriod().key]=num($('#jinhyukSalary').value); await persistRemote(); });
  $('#saveDahyeSalary').addEventListener('click', async()=>{ const d=state.salary.dahye; d.base=num($('#dahyeBase').value); d.rates={weekday:num($('#rateWeekday').value),holiday:num($('#rateHoliday').value),sunday:num($('#rateSunday').value),monThu:num($('#rateMonThu').value),friday:num($('#rateFriday').value)}; d.tax={pension:num($('#taxPension').value), incomeTax:num($('#taxIncome').value), vehicleAllowance:num($('#taxVehicle').value), memoDeduct:num($('#taxMemoDeduct').value)}; $$('[data-duty-month]').forEach(inp=>{ const m=inp.dataset.dutyMonth; const k=inp.dataset.dutyKey; d.months[m]=d.months[m]||{}; d.months[m][k]=num(inp.value); }); await persistRemote(); });
  $('#saveAssetsBtn').addEventListener('click', async()=>{ $$('[data-asset]').forEach(i=>state.assets[i.dataset.asset]=num(i.value)); await persistRemote(); });
  $('#saveInvestBtn').addEventListener('click', async()=>{ state.investments=state.investments.map((it,i)=>({...it,type:$(`[data-invest-type="${i}"]`)?.value||it.type,name:$(`[data-invest-name="${i}"]`)?.value||'',principal:num($(`[data-invest-principal="${i}"]`)?.value),current:num($(`[data-invest-current="${i}"]`)?.value)})); await persistRemote(); });
  $('#connectBtn').addEventListener('click', connectFirebase);
  $('#cycleStartDay').addEventListener('change', async()=>{ state.settings.cycleStartDay=num($('#cycleStartDay').value)||10; await persistRemote(); });
  $('#backupBtn').addEventListener('click',()=>{ const blob=new Blob([JSON.stringify(stripRuntime(state),null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`hzzdzz-backup-${ymd(new Date())}.json`; a.click(); URL.revokeObjectURL(a.href); });
  $('#restoreBtn').addEventListener('click',()=>$('#restoreFile').click());
  $('#restoreFile').addEventListener('change', async e=>{ const file=e.target.files[0]; if(!file) return; const text=await file.text(); state=mergeDefaults(JSON.parse(text)); await persistRemote(); alert('복원 완료'); });
  window.addEventListener('online', ()=>refreshFromFirebase(false));
}

function clearExpenseForm(){ $('#expenseId').value=''; $('#expenseDate').value=ymd(new Date()); $('#expenseAmount').value=''; $('#expenseMemo').value=''; }

bindEvents(); setupPullToRefresh(); render();
try{ const sync=JSON.parse(localStorage.getItem('hzzdzz_sync_settings')||'null'); if(sync?.firebaseConfigText){ state.settings={...state.settings,...sync}; persistLocal(); connectFirebase(); } else setBadge('오프라인','off'); } catch { setBadge('오프라인','off'); }
