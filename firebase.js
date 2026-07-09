import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc, getDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

let app = null;
let db = null;
let unsub = null;
let activeRef = null;

export function parseFirebaseConfig(input){
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
    if(incoming.length === 0 && Array.isArray(existing) && existing.length > 0) return existing;
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

export async function saveHousehold(data, options = {}){
  if(!activeRef) throw new Error('동기화 문서가 연결되지 않았습니다.');
  const existingSnap = await getDoc(activeRef);
  const existing = existingSnap.exists() ? existingSnap.data() : {};
  let payload = {...data, updatedAt: serverTimestamp(), appVersion:'1.0.0'};

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
