import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp, enableIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

const STORAGE_KEY = 'couple-budget-v3-local';
const SYNC_KEY = 'couple-budget-v3-sync';
const DEFAULT_HOUSEHOLD_ID = 'hzzdzz_가계부';
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });

const state = {
  entries: JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('couple-budget-v2-local') || '[]'),
  mode: 'local',
  db: null,
  householdId: DEFAULT_HOUSEHOLD_ID,
  unsubscribe: null
};

function todayISO(){const d=new Date();const tz=d.getTimezoneOffset()*60000;return new Date(d-tz).toISOString().slice(0,10)}
function saveLocal(){localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries))}
function currentMonthEntries(){const ym=todayISO().slice(0,7);return state.entries.filter(e=>e.date?.startsWith(ym))}
function sum(list,type){return list.filter(e=>e.type===type).reduce((a,e)=>a+Number(e.amount||0),0)}
function escapeHtml(text){return String(text ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function setStatus(text,on=false){$('syncStatus').textContent=text;$('syncStatus').classList.toggle('on',on)}

function parseFirebaseConfig(raw){
  const text = (raw || '').trim();
  if(!text) throw new Error('empty');

  // 1) Pure JSON
  try { return normalizeConfig(JSON.parse(text)); } catch (_) {}

  // 2) Firebase console code: const firebaseConfig = { ... };
  const match = text.match(/firebaseConfig\s*=\s*({[\s\S]*?})\s*;?/);
  const objectText = match ? match[1] : text.match(/{[\s\S]*}/)?.[0];
  if(!objectText) throw new Error('not_found');

  // Convert JS object literal copied from Firebase to JSON.
  const jsonLike = objectText
    .replace(/\/\/.*$/gm, '')
    .replace(/,\s*}/g, '}')
    .replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');

  return normalizeConfig(JSON.parse(jsonLike));
}

function normalizeConfig(config){
  const required = ['apiKey','authDomain','projectId','appId'];
  for(const key of required){
    if(!config?.[key]) throw new Error(`missing_${key}`);
  }
  return {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket || '',
    messagingSenderId: config.messagingSenderId || '',
    appId: config.appId,
    measurementId: config.measurementId || ''
  };
}

function getFirebaseApp(config){
  const name = `budget-${config.projectId}`;
  return getApps().some(app => app.name === name) ? getApp(name) : initializeApp(config, name);
}

function entriesCollection(){return collection(state.db, 'households', state.householdId, 'entries')}

async function connectFirebase(config, householdId){
  try{
    if(state.unsubscribe) state.unsubscribe();
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

    const q = query(entriesCollection(), orderBy('date','desc'));
    state.unsubscribe = onSnapshot(q, snap => {
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
  if(state.unsubscribe) state.unsubscribe();
  state.unsubscribe = null; state.db = null; state.householdId = DEFAULT_HOUSEHOLD_ID; state.mode = 'local';
  localStorage.removeItem(SYNC_KEY); setStatus('로컬 저장', false); renderAll();
}

function renderSummary(){const list=currentMonthEntries();const income=sum(list,'income');const expense=sum(list,'expense');const balance=income-expense;const savingRate=income>0?Math.round((balance/income)*100):0;$('monthIncome').textContent=fmt.format(income);$('monthExpense').textContent=fmt.format(expense);$('monthBalance').textContent=fmt.format(balance);$('savingRate').textContent=`${savingRate}%`}
function renderOwners(){const list=currentMonthEntries();$('ownerStats').innerHTML=['진혁','다혜','공동'].map(owner=>{const mine=list.filter(e=>e.owner===owner);const income=sum(mine,'income');const expense=sum(mine,'expense');return `<div class="owner-card"><b>${owner}</b><b>${fmt.format(income-expense)}</b><span>수입 ${fmt.format(income)}</span><span>지출 ${fmt.format(expense)}</span></div>`}).join('')}
function renderEntries(){const sorted=[...state.entries].sort((a,b)=>(b.date||'').localeCompare(a.date||'') || Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,30);if(!sorted.length){$('entryList').innerHTML='<div class="empty">아직 입력된 내역이 없습니다.</div>';return}$('entryList').innerHTML=sorted.map(e=>`<div class="entry-item"><div class="memo">${escapeHtml(e.memo)}</div><div class="amount ${e.type}">${e.type==='expense'?'-':'+'}${fmt.format(e.amount)}</div><div class="meta">${escapeHtml(e.date)} · ${escapeHtml(e.owner)} · ${escapeHtml(e.category)}</div><button type="button" data-delete="${escapeHtml(e.id)}">삭제</button></div>`).join('')}
function renderInsights(){const list=currentMonthEntries();const income=sum(list,'income');const expense=sum(list,'expense');const balance=income-expense;const expenseList=list.filter(e=>e.type==='expense');const byCategory=expenseList.reduce((a,e)=>(a[e.category]=(a[e.category]||0)+Number(e.amount),a),{});const top=Object.entries(byCategory).sort((a,b)=>b[1]-a[1])[0];const savingRate=income>0?Math.round((balance/income)*100):0;const joint=expenseList.filter(e=>e.owner==='공동').reduce((a,e)=>a+Number(e.amount),0);const messages=[];if(!list.length)messages.push('이번 달 내역을 입력하면 소비 패턴을 자동으로 분석합니다.');if(top)messages.push(`이번 달 가장 큰 지출 분류는 ${top[0]}이며, 총 ${fmt.format(top[1])} 사용했습니다.`);if(joint>0)messages.push(`공동 지출은 총 ${fmt.format(joint)}입니다. 1인 기준으로 보면 약 ${fmt.format(Math.round(joint/2))}입니다.`);if(income>0)messages.push(`현재 저축률은 ${savingRate}%입니다. 목표 저축률을 정하면 달성 여부를 표시할 수 있습니다.`);if(expense>income&&income>0)messages.push('이번 달은 지출이 수입보다 많습니다. 공동지출과 고정지출을 먼저 점검하는 것이 좋습니다.');if(expenseList.length>=5)messages.push(`이번 달 지출 입력은 ${expenseList.length}건입니다. 자주 반복되는 지출은 고정지출로 분리하면 관리가 쉬워집니다.`);$('insights').innerHTML=messages.map(m=>`<div class="insight">${escapeHtml(m)}</div>`).join('')}
function renderCategories(){const list=currentMonthEntries().filter(e=>e.type==='expense');const total=sum(list,'expense');const by=list.reduce((a,e)=>(a[e.category]=(a[e.category]||0)+Number(e.amount),a),{});const rows=Object.entries(by).sort((a,b)=>b[1]-a[1]);$('categoryStats').innerHTML=rows.length?rows.map(([cat,amt])=>`<div class="category-row"><b>${escapeHtml(cat)}</b><b>${fmt.format(amt)}</b><span>전체 지출의 ${total?Math.round(amt/total*100):0}%</span></div>`).join(''):'<div class="empty">지출 내역이 생기면 분류별 통계가 표시됩니다.</div>'}
function renderAll(){renderSummary();renderOwners();renderEntries();renderInsights();renderCategories()}

async function addEntry(data){
  const entry={...data, amount:Number(data.amount), createdAt:Date.now()};
  if(state.mode==='firebase'&&state.db){
    await addDoc(entriesCollection(), {...entry, createdServerAt:serverTimestamp()});
  }else{
    state.entries.push({id:crypto.randomUUID(),...entry});saveLocal();renderAll();
  }
}
async function removeEntry(id){if(state.mode==='firebase'&&state.db){await deleteDoc(doc(state.db,'households',state.householdId,'entries',id));}else{state.entries=state.entries.filter(e=>e.id!==id);saveLocal();renderAll();}}

$('entryForm').addEventListener('submit',async ev=>{ev.preventDefault();const form=new FormData(ev.currentTarget);try{await addEntry({type:form.get('type'),owner:$('owner').value,date:$('date').value,memo:$('memo').value.trim(),amount:$('amount').value,category:$('category').value});$('memo').value='';$('amount').value='';showPage('home')}catch(e){console.error(e);alert('입력 저장 중 오류가 발생했습니다. Firebase 연결과 Firestore 권한을 확인해주세요.')}});
$('entryList').addEventListener('click',ev=>{const id=ev.target?.dataset?.delete;if(id&&confirm('이 내역을 삭제할까요?')) removeEntry(id)});
$('sampleBtn').addEventListener('click',()=>{const today=todayISO();[{type:'income',owner:'진혁',date:today,memo:'월급',amount:3500000,category:'급여'},{type:'income',owner:'다혜',date:today,memo:'월급',amount:2700000,category:'급여'},{type:'expense',owner:'공동',date:today,memo:'마트 장보기',amount:86000,category:'식비'},{type:'expense',owner:'진혁',date:today,memo:'주유',amount:50000,category:'교통/차량'},{type:'expense',owner:'다혜',date:today,memo:'카페',amount:12000,category:'카페/간식'}].forEach(addEntry)});
$('resetBtn').addEventListener('click',()=>{if(!confirm('현재 기기에 저장된 로컬 데이터를 삭제할까요? Firebase 데이터는 삭제하지 않습니다.'))return;state.entries=[];saveLocal();renderAll()});
$('syncForm').addEventListener('submit',async ev=>{ev.preventDefault();const householdId=$('householdId').value.trim() || DEFAULT_HOUSEHOLD_ID;try{const config=parseFirebaseConfig($('firebaseConfig').value);await connectFirebase(config,householdId)}catch(e){console.error(e);alert('Firebase 설정값을 읽지 못했습니다. Firebase에서 복사한 <script> 코드 전체 또는 JSON을 그대로 붙여넣어주세요.')}});
$('localModeBtn').addEventListener('click',disconnectFirebase);

function showPage(name){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===name));document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.target===name))}
document.querySelector('.bottom-nav').addEventListener('click',ev=>{const target=ev.target?.dataset?.target;if(target)showPage(target)});

$('date').value=todayISO();$('todayText').textContent=todayISO();$('householdId').value=DEFAULT_HOUSEHOLD_ID;
const saved=JSON.parse(localStorage.getItem(SYNC_KEY)||localStorage.getItem('couple-budget-v2-sync')||'null');
if(saved?.config&&saved?.householdId){$('householdId').value=saved.householdId;$('firebaseConfig').value=JSON.stringify(saved.config,null,2);connectFirebase(saved.config,saved.householdId)}else{setStatus('로컬 저장',false);renderAll()}
