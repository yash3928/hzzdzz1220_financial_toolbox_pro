import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc, getDoc, serverTimestamp, collection, addDoc, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

let app = null;
let db = null;
let unsub = null;
let activeRef = null;

export function parseFirebaseConfig(input){
  if(input && typeof input === 'object') return input;
  const text = (input || '').trim();
  if(!text) throw new Error('Firebase 설정값이 비어 있습니다.');
  const match = text.match(/firebaseConfig\s*=\s*({[\s\S]*?})\s*;?/);
  const raw = match ? match[1] : text;
  try { return JSON.parse(raw); } catch (_) {}
  try {
    // Firebase가 제공하는 JS 객체 형태도 허용합니다. 입력값은 사용자 Firebase 설정용입니다.
    return Function(`"use strict"; return (${raw});`)();
  } catch (err) {
    throw new Error('Firebase 설정값 형식을 읽을 수 없습니다.');
  }
}

export function initFirebase(config){
  if(!config || !config.projectId) throw new Error('projectId가 없습니다.');
  app = getApps().length ? getApps()[0] : initializeApp(config);
  db = getFirestore(app);
  return db;
}

export function subscribeHousehold(householdId, callback, errorCallback){
  if(!db) throw new Error('Firebase가 초기화되지 않았습니다.');
  if(unsub) unsub();
  activeRef = doc(db, 'households', householdId);
  unsub = onSnapshot(activeRef, snap => {
    callback(snap.exists() ? snap.data() : null);
  }, err => {
    if(errorCallback) errorCallback(err);
  });
}


function isPlainObject(v){ return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date); }
function hasMeaningfulValue(v){
  if(Array.isArray(v)) return v.length > 0;
  if(isPlainObject(v)) return Object.values(v).some(hasMeaningfulValue);
  if(typeof v === 'number') return v !== 0;
  if(typeof v === 'string') return v.trim() !== '';
  return v !== null && v !== undefined;
}
function deepPreserve(existing, incoming){
  if(Array.isArray(incoming)){
    // 배열은 사용자가 항목을 삭제한 결과일 수 있으므로 빈 배열도 그대로 저장합니다.
    // 기존 로직은 마지막 지출을 삭제했을 때 Firebase의 이전 배열을 되살리는 문제가 있었습니다.
    return incoming;
  }
  if(isPlainObject(incoming)){
    if(isPlainObject(existing) && !hasMeaningfulValue(incoming) && hasMeaningfulValue(existing)) return existing;
    const out = {...(isPlainObject(existing) ? existing : {})};
    for(const [k,v] of Object.entries(incoming)) out[k] = deepPreserve(existing?.[k], v);
    return out;
  }
  return incoming;
}

async function saveCloudBackup(existing){
  if(!activeRef || !existing || !hasMeaningfulValue(existing)) return;
  try{
    const backupsRef = collection(activeRef, 'backups');
    const clean = JSON.parse(JSON.stringify(existing));
    delete clean.updatedAt;
    await addDoc(backupsRef, { data: clean, savedAt: serverTimestamp(), appVersion: '1.4.5' });
  }catch(e){ console.warn('클라우드 자동 백업 실패', e); }
}

export async function saveHousehold(data, options = {}){
  if(!activeRef) throw new Error('동기화 문서가 연결되지 않았습니다.');
  const existingSnap = await getDoc(activeRef);
  const existing = existingSnap.exists() ? existingSnap.data() : {};
  if(existingSnap.exists() && !options.skipBackup) await saveCloudBackup(existing);
  let payload = {...data, updatedAt: serverTimestamp(), appVersion:'1.4.5', schemaVersion:1};

  // forceRestore일 때만 백업 파일 내용으로 덮어씁니다.
  // 일반 저장/업데이트에서는 빈 기본값이 기존 Firebase 데이터를 덮지 못하도록 전역 보호합니다.
  if(!options.forceRestore){
    payload = deepPreserve(existing, payload);
  }

  await setDoc(activeRef, payload, {merge:true});
}

export async function fetchHousehold(){
  if(!activeRef) throw new Error('동기화 문서가 연결되지 않았습니다.');
  const snap = await getDoc(activeRef);
  return snap.exists() ? snap.data() : null;
}

export function disconnectFirebase(){
  if(unsub) unsub();
  unsub = null;
  activeRef = null;
}

export async function fetchLatestCloudBackup(){
  if(!activeRef) throw new Error('동기화 문서가 연결되지 않았습니다.');
  const q=query(collection(activeRef,'backups'), orderBy('savedAt','desc'), limit(1));
  const snap=await getDocs(q);
  if(snap.empty) return null;
  return snap.docs[0].data()?.data || null;
}
