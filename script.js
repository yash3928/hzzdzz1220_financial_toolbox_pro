import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp, enableIndexedDbPersistence,
  setDoc
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

const STORAGE_KEY = 'couple-budget-v4-local';
const SETTINGS_KEY = 'couple-budget-v4-settings';
const SYNC_KEY = 'couple-budget-v3-sync';
const DEFAULT_HOUSEHOLD_ID = 'hzzdzz_가계부';
const BUDGET_CATEGORIES = ['식비', '생필품', '의료', '비상금'];
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });

const defaultSettings = {
  monthStartDay: 10,
  budgets: { 식비: 0, 생필품: 0, 의료: 0, 비상금: 0 },
  assets: [],
  investment: { principal: 0, current: 0 },
  duty: {}
};

const state = {
  entries: JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('couple-budget-v3-local') || '[]'),
  settings: mergeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')),
  mode: 'local',
  db: null,
  householdId: DEFAULT_HOUSEHOLD_ID,
  unsubscribeEntries: null,
  unsubscribeSettings: null
};

function mergeSettings(saved){
  const s = saved || {};
  return {
    ...defaultSettings,
    ...s,
    budgets: { ...defaultSettings.budgets, ...(s.budgets || {}) },
    investment: { ...defaultSettings.investment, ...(s.investment || {}) },
    assets: Array.isArray(s.assets) ? s.assets : [],
    duty: s.duty || {}
  };
}
function todayISO(){ const d=new Date(); const tz=d.getTimezoneOffset()*60000; return new Date(d-tz).toISOString().slice(0,10); }
function dateISO(d){ const tz=d.getTimezoneOffset()*60000; return new Date(d-tz).toISOString().slice(0,10); }
function saveLocal(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries)); }
function saveSettingsLocal(){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
function escapeHtml(text){ return String(text ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function setStatus(text,on=false){ $('syncStatus').textContent=text; $('syncStatus').classList.toggle('on',on); }
function num(v){ return Number(v || 0); }

function getPeriod(target = new Date()){
  const startDay = Math.max(1, Math.min(28, Number(state.settings.monthStartDay || 10)));
  let y = target.getFullYear();
  let m = target.getMonth();
  if(target.getDate() < startDay) m -= 1;
  const start = new Date(y, m, startDay);
  const end = new Date(y, m + 1, startDay - 1);
  const key = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}`;
  const label = `${start.getMonth()+1}월 가계부`;
  return { start, end, startISO: dateISO(start), endISO: dateISO(end), key, label };
}
function currentPeriodEntries(){
  const p = getPeriod();
  return state.entries.filter(e => e.date >= p.startISO && e.date <= p.endISO);
}
function sum(list,type){ return list.filter(e=>e.type===type).reduce((a,e)=>a+num(e.amount),0); }
function budgetTotal(){ return BUDGET_CATEGORIES.reduce((a,c)=>a+num(state.settings.budgets[c]),0); }
function budgetUsed(list){ return list.filter(e=>e.type==='expense' && BUDGET_CATEGORIES.includes(e.category)).reduce((a,e)=>a+num(e.amount),0); }

function parseFirebaseConfig(raw){
  const text = (raw || '').trim();
  if(!text) throw new Error('empty');
  try { return normalizeConfig(JSON.parse(text)); } catch (_) {}
  const match = text.match(/firebaseConfig\s*=\s*({[\s\S]*?})\s*;?/);
  const objectText = match ? match[1] : text.match(/{[\s\S]*}/)?.[0];
  if(!objectText) throw new Error('not_found');
  const jsonLike = objectText
    .replace(/\/\/.*$/gm, '')
    .replace(/,\s*}/g, '}')
    .replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  return normalizeConfig(JSON.parse(jsonLike));
}
function normalizeConfig(config){
  const required = ['apiKey','authDomain','projectId','appId'];
  for(const key of required){ if(!config?.[key]) throw new Error(`missing_${key}`); }
  return {
    apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId,
    storageBucket: config.storageBucket || '', messagingSenderId: config.messagingSenderId || '',
    appId: config.appId, measurementId: config.measurementId || ''
  };
}
function getFirebaseApp(config){
  const name = `budget-${config.projectId}`;
  return getApps().some(app => app.name === name) ? getApp(name) : initializeApp(config, name);
}
function entriesCollection(){ return collection(state.db, 'households', state.householdId, 'entries'); }
function settingsDoc(){ return doc(state.db, 'households', state.householdId, 'settings', 'main'); }
async function saveSettings(){
  saveSettingsLocal();
  if(state.mode === 'firebase' && state.db){ await setDoc(settingsDoc(), state.settings, { merge: true }); }
  renderAll();
}

async function connectFirebase(config, householdId){
  try{
    if(state.unsubscribeEntries) state.unsubscribeEntries();
    if(state.unsubscribeSettings) state.unsubscribeSettings();
    const cleanedId = (householdId || DEFAULT_HOUSEHOLD_ID).trim().replaceAll('/', '_');
    const app = getFirebaseApp(config);
    state.db = getFirestore(app);
    state.householdId = cleanedId;
    try{ await enableIndexedDbPersistence(state.db); }catch(e){ console.warn('offline persistence skipped', e); }
    state.mode = 'firebase';
    localStorage.setItem(SYNC_KEY, JSON.stringify({ config, householdId: state.householdId }));
    $('householdId').value = state.householdId;
    $('firebaseConfig').value = JSON.stringify(config, null, 2);
    setStatus('연결 중...', true);

    state.unsubscribeSettings = onSnapshot(settingsDoc(), snap => {
      if(snap.exists()){
        state.settings = mergeSettings(snap.data());
        saveSettingsLocal();
      }else{
        setDoc(settingsDoc(), state.settings, { merge: true });
      }
      setStatus('공동 동기화', true);
      fillSettingsForms();
      renderAll();
    });
    const q = query(entriesCollection(), orderBy('date','desc'));
    state.unsubscribeEntries = onSnapshot(q, snap => {
      state.entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setStatus('공동 동기화', true);
      renderAll();
    }, err => {
      console.error(err);
      alert('Firebase 연결 오류입니다. Firestore Database 생성 여부와 보안 규칙을 확인해주세요.');
      setStatus('연결 오류', false);
    });
  }catch(err){
    console.error(err);
    alert('Firebase 설정값을 확인해주세요. Firebase 웹 앱 설정 코드 또는 JSON 전체를 붙여넣으면 됩니다.');
    setStatus('연결 오류', false);
  }
}
function disconnectFirebase(){
  if(state.unsubscribeEntries) state.unsubscribeEntries();
  if(state.unsubscribeSettings) state.unsubscribeSettings();
  state.unsubscribeEntries = null; state.unsubscribeSettings = null; state.db = null; state.householdId = DEFAULT_HOUSEHOLD_ID; state.mode = 'local';
  localStorage.removeItem(SYNC_KEY); setStatus('로컬 저장', false); renderAll();
}

async function addEntry(data){
  const entry = { ...data, amount: num(data.amount), createdAt: Date.now() };
  if(state.mode === 'firebase' && state.db){
    await addDoc(entriesCollection(), { ...entry, createdServerAt: serverTimestamp() });
  }else{
    state.entries.push({ id: crypto.randomUUID(), ...entry }); saveLocal(); renderAll();
  }
}
async function removeEntry(id){
  if(state.mode === 'firebase' && state.db){ await deleteDoc(doc(state.db,'households',state.householdId,'entries',id)); }
  else{ state.entries = state.entries.filter(e=>e.id!==id); saveLocal(); renderAll(); }
}

function getDahyeDuty(year, month){
  const y = String(year);
  const data = state.settings.duty?.[y] || {};
  const rates = data.rates || {};
  const m = data.months?.[String(month)] || {};
  const weekday = num(m.weekday) * num(rates.weekday);
  const weekend = num(m.weekend) * num(rates.weekend);
  const holiday = num(m.holiday) * num(rates.holiday);
  return { weekday, weekend, holiday, total: weekday + weekend + holiday, counts: m, rates };
}
function updateDahyeDutyPreview(){
  const owner = $('salaryOwner').value;
  const date = $('salaryDate').value || todayISO();
  const d = new Date(`${date}T00:00:00`);
  const duty = getDahyeDuty(d.getFullYear(), d.getMonth()+1);
  $('dahyeDutyBox').classList.toggle('hidden', owner !== '다혜');
  if(owner === '다혜'){
    $('baseSalaryLabel').firstChild.textContent = '기본급';
    $('dahyeDutyBox').innerHTML = `선택 월 당직수당: <b>${fmt.format(duty.total)}</b><br>평일 ${num(duty.counts.weekday)}회 · 주말 ${num(duty.counts.weekend)}회 · 공휴일 ${num(duty.counts.holiday)}회`;
  }else{
    $('baseSalaryLabel').firstChild.textContent = '실수령액';
  }
}

function renderSummary(){
  const list = currentPeriodEntries();
  const income = sum(list,'income');
  const expense = sum(list,'expense');
  const remain = budgetTotal() - budgetUsed(list);
  const assets = state.settings.assets.reduce((a,x)=>a+num(x.amount),0);
  const invest = num(state.settings.investment.current);
  $('budgetRemain').textContent = fmt.format(remain);
  $('totalAssets').textContent = fmt.format(assets);
  $('investmentAssets').textContent = fmt.format(invest);
  $('periodIncome').textContent = fmt.format(income);
  $('periodExpense').textContent = fmt.format(expense);
}
function renderPeriodText(){
  const p = getPeriod();
  $('periodText').textContent = `${p.label} · ${p.startISO} ~ ${p.endISO}`;
  $('monthRuleText').textContent = `매월 ${state.settings.monthStartDay}일 시작`;
}
function renderBudgets(){
  const list = currentPeriodEntries().filter(e=>e.type==='expense');
  $('budgetCards').innerHTML = BUDGET_CATEGORIES.map(cat => {
    const budget = num(state.settings.budgets[cat]);
    const used = list.filter(e=>e.category===cat).reduce((a,e)=>a+num(e.amount),0);
    const remain = budget - used;
    const pct = budget > 0 ? Math.min(100, Math.round(used / budget * 100)) : 0;
    const warn = budget > 0 && used > budget ? ' over' : '';
    return `<div class="budget-card${warn}">
      <div class="budget-top"><b>${cat}</b><span>${fmt.format(remain)} 남음</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="budget-meta">${fmt.format(used)} / ${fmt.format(budget)} · ${budget ? Math.round(used/budget*100) : 0}%</div>
    </div>`;
  }).join('');
}
function renderEntries(){
  const sorted=[...state.entries].sort((a,b)=>(b.date||'').localeCompare(a.date||'') || num(b.createdAt)-num(a.createdAt)).slice(0,40);
  if(!sorted.length){ $('entryList').innerHTML='<div class="empty">아직 입력된 내역이 없습니다.</div>'; return; }
  $('entryList').innerHTML = sorted.map(e=>`<div class="entry-item"><div class="memo">${escapeHtml(e.memo)}</div><div class="amount ${e.type}">${e.type==='expense'?'-':'+'}${fmt.format(e.amount)}</div><div class="meta">${escapeHtml(e.date)} · ${escapeHtml(e.owner)} · ${escapeHtml(e.category)}</div><button type="button" data-delete="${escapeHtml(e.id)}">삭제</button></div>`).join('');
}
function renderAssets(){
  const list = state.settings.assets || [];
  $('assetList').innerHTML = list.length ? list.map((a,i)=>`<div class="asset-item"><b>${escapeHtml(a.name)}</b><b>${fmt.format(a.amount)}</b><span>${escapeHtml(a.type)}</span><button type="button" data-asset-delete="${i}">삭제</button></div>`).join('') : '<div class="empty">자산을 입력하면 총자산이 자동 계산됩니다.</div>';
  $('investPrincipal').value = state.settings.investment.principal || '';
  $('investCurrent').value = state.settings.investment.current || '';
  const p = num(state.settings.investment.principal), c = num(state.settings.investment.current);
  const profit = c - p;
  const rate = p ? (profit / p * 100).toFixed(1) : '0.0';
  $('investmentResult').innerHTML = `투자 손익 <b>${fmt.format(profit)}</b> · 수익률 <b>${rate}%</b>`;
}
function renderInsights(){
  const list=currentPeriodEntries();
  const expenseList=list.filter(e=>e.type==='expense');
  const income=sum(list,'income');
  const expense=sum(list,'expense');
  const used=budgetUsed(list); const total=budgetTotal();
  const messages=[];
  if(!list.length) messages.push('이번 기간 내역을 입력하면 예산 사용률과 소비 패턴을 자동 분석합니다.');
  if(total>0) messages.push(`공동예산은 ${fmt.format(total)} 중 ${fmt.format(used)} 사용했습니다. 잔액은 ${fmt.format(total-used)}입니다.`);
  const by=expenseList.reduce((a,e)=>(a[e.category]=(a[e.category]||0)+num(e.amount),a),{});
  const top=Object.entries(by).sort((a,b)=>b[1]-a[1])[0];
  if(top) messages.push(`가장 많이 사용한 분류는 ${top[0]}이며 ${fmt.format(top[1])}입니다.`);
  BUDGET_CATEGORIES.forEach(cat=>{
    const budget=num(state.settings.budgets[cat]); const spent=num(by[cat]);
    if(budget && spent/budget >= 1) messages.push(`${cat} 예산을 초과했습니다. 다음 지출 전에 잔액 확인이 필요합니다.`);
    else if(budget && spent/budget >= .8) messages.push(`${cat} 예산을 80% 이상 사용했습니다. 남은 기간을 고려해 조절하면 좋습니다.`);
  });
  if(income>0) messages.push(`이번 기간 저축 예상액은 ${fmt.format(income-expense)}입니다.`);
  $('insights').innerHTML=messages.map(m=>`<div class="insight">${escapeHtml(m)}</div>`).join('');
}
function renderCategories(){
  const list=currentPeriodEntries().filter(e=>e.type==='expense');
  const by=list.reduce((a,e)=>(a[e.category]=(a[e.category]||0)+num(e.amount),a),{});
  $('categoryStats').innerHTML = BUDGET_CATEGORIES.map(cat=>{
    const budget=num(state.settings.budgets[cat]); const spent=num(by[cat]);
    return `<div class="category-row"><b>${cat}</b><b>${fmt.format(spent)}</b><span>예산 ${fmt.format(budget)} · 잔액 ${fmt.format(budget-spent)}</span></div>`;
  }).join('');
}
function renderAll(){ renderPeriodText(); renderSummary(); renderBudgets(); renderEntries(); renderAssets(); renderInsights(); renderCategories(); }

function fillSettingsForms(){
  $('monthStartDay').value = state.settings.monthStartDay || 10;
  $('budgetFood').value = state.settings.budgets.식비 || '';
  $('budgetLiving').value = state.settings.budgets.생필품 || '';
  $('budgetMedical').value = state.settings.budgets.의료 || '';
  $('budgetEmergency').value = state.settings.budgets.비상금 || '';
  const year = Number($('dutyYear').value || new Date().getFullYear());
  const duty = state.settings.duty[String(year)] || { rates:{}, months:{} };
  $('weekdayRate').value = duty.rates?.weekday || '';
  $('weekendRate').value = duty.rates?.weekend || '';
  $('holidayRate').value = duty.rates?.holiday || '';
  renderDutyMonths(year);
}
function renderDutyMonths(year){
  const duty = state.settings.duty[String(year)] || { months:{} };
  $('dutyMonths').innerHTML = Array.from({length:12},(_,i)=>{
    const m = i + 1; const data = duty.months?.[String(m)] || {};
    return `<div class="duty-row"><b>${m}월</b><input data-duty-month="${m}" data-duty-type="weekday" type="number" min="0" placeholder="평일" value="${data.weekday || ''}"><input data-duty-month="${m}" data-duty-type="weekend" type="number" min="0" placeholder="주말" value="${data.weekend || ''}"><input data-duty-month="${m}" data-duty-type="holiday" type="number" min="0" placeholder="공휴일" value="${data.holiday || ''}"></div>`;
  }).join('');
}

$('expenseForm').addEventListener('submit', async ev=>{
  ev.preventDefault();
  try{
    await addEntry({ type:'expense', owner:$('expenseOwner').value, date:$('expenseDate').value, memo:$('expenseMemo').value.trim(), amount:$('expenseAmount').value, category:$('expenseCategory').value });
    $('expenseMemo').value=''; $('expenseAmount').value=''; showPage('home');
  }catch(e){ console.error(e); alert('지출 저장 중 오류가 발생했습니다.'); }
});
$('salaryForm').addEventListener('submit', async ev=>{
  ev.preventDefault();
  const owner = $('salaryOwner').value; const date = $('salaryDate').value; const base = num($('salaryBase').value);
  const d = new Date(`${date}T00:00:00`); const duty = owner === '다혜' ? getDahyeDuty(d.getFullYear(), d.getMonth()+1).total : 0;
  const amount = base + duty;
  const memo = owner === '다혜' ? `다혜 월급(기본급+당직 ${fmt.format(duty)})` : '진혁 월급';
  await addEntry({ type:'income', owner, date, memo, amount, category:'급여' });
  $('salaryBase').value=''; showPage('home');
});
$('salaryOwner').addEventListener('change', updateDahyeDutyPreview);
$('salaryDate').addEventListener('change', updateDahyeDutyPreview);
$('entryList').addEventListener('click', ev=>{ const id=ev.target?.dataset?.delete; if(id&&confirm('이 내역을 삭제할까요?')) removeEntry(id); });
$('sampleBtn').addEventListener('click',()=>{
  const today=todayISO();
  [{type:'expense',owner:'공동',date:today,memo:'마트 장보기',amount:86000,category:'식비'}, {type:'expense',owner:'다혜',date:today,memo:'생필품 구매',amount:42000,category:'생필품'}, {type:'expense',owner:'진혁',date:today,memo:'약국',amount:12000,category:'의료'}].forEach(addEntry);
});
$('assetForm').addEventListener('submit', async ev=>{
  ev.preventDefault();
  state.settings.assets.push({ id: crypto.randomUUID(), type:$('assetType').value, name:$('assetName').value.trim(), amount:num($('assetAmount').value) });
  $('assetName').value=''; $('assetAmount').value=''; await saveSettings();
});
$('assetList').addEventListener('click', async ev=>{ const idx=ev.target?.dataset?.assetDelete; if(idx!==undefined){ state.settings.assets.splice(Number(idx),1); await saveSettings(); } });
$('investmentForm').addEventListener('submit', async ev=>{ ev.preventDefault(); state.settings.investment = { principal:num($('investPrincipal').value), current:num($('investCurrent').value) }; await saveSettings(); });
$('budgetForm').addEventListener('submit', async ev=>{
  ev.preventDefault();
  state.settings.monthStartDay = num($('monthStartDay').value) || 10;
  state.settings.budgets = { 식비:num($('budgetFood').value), 생필품:num($('budgetLiving').value), 의료:num($('budgetMedical').value), 비상금:num($('budgetEmergency').value) };
  await saveSettings(); alert('예산 설정을 저장했습니다.');
});
$('dutyYear').addEventListener('change', () => fillSettingsForms());
$('dutyForm').addEventListener('submit', async ev=>{
  ev.preventDefault();
  const year = String($('dutyYear').value || new Date().getFullYear());
  const months = {};
  document.querySelectorAll('[data-duty-month]').forEach(input=>{
    const m = input.dataset.dutyMonth; const type = input.dataset.dutyType;
    months[m] = months[m] || {}; months[m][type] = num(input.value);
  });
  state.settings.duty[year] = { rates: { weekday:num($('weekdayRate').value), weekend:num($('weekendRate').value), holiday:num($('holidayRate').value) }, months };
  await saveSettings(); updateDahyeDutyPreview(); alert('다혜 연간 당직 설정을 저장했습니다.');
});
$('syncForm').addEventListener('submit', async ev=>{ ev.preventDefault(); try{ const config=parseFirebaseConfig($('firebaseConfig').value); await connectFirebase(config, $('householdId').value.trim() || DEFAULT_HOUSEHOLD_ID); }catch(e){ console.error(e); alert('Firebase 설정값을 읽지 못했습니다. <script> 코드 전체 또는 JSON을 붙여넣어주세요.'); } });
$('localModeBtn').addEventListener('click', disconnectFirebase);
$('resetBtn').addEventListener('click',()=>{ if(!confirm('현재 기기에 저장된 로컬 데이터를 삭제할까요? Firebase 데이터는 삭제하지 않습니다.'))return; state.entries=[]; saveLocal(); renderAll(); });

function showPage(name){ document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===name)); document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.target===name)); }
document.querySelector('.bottom-nav').addEventListener('click',ev=>{ const target=ev.target?.dataset?.target; if(target)showPage(target); });

(function init(){
  $('expenseDate').value=todayISO(); $('salaryDate').value=todayISO(); $('dutyYear').value=new Date().getFullYear(); $('householdId').value=DEFAULT_HOUSEHOLD_ID;
  $('monthStartDay').innerHTML = Array.from({length:28},(_,i)=>`<option value="${i+1}">매월 ${i+1}일</option>`).join('');
  fillSettingsForms(); updateDahyeDutyPreview();
  const saved=JSON.parse(localStorage.getItem(SYNC_KEY)||localStorage.getItem('couple-budget-v2-sync')||'null');
  if(saved?.config&&saved?.householdId){ $('householdId').value=saved.householdId; $('firebaseConfig').value=JSON.stringify(saved.config,null,2); connectFirebase(saved.config,saved.householdId); }
  else{ setStatus('로컬 저장',false); renderAll(); }
})();
