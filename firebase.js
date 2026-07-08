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

export async function saveHousehold(data){
  if(!activeRef) throw new Error('동기화 문서가 연결되지 않았습니다.');
  const existingSnap = await getDoc(activeRef);
  const existing = existingSnap.exists() ? existingSnap.data() : {};
  const payload = {...data, updatedAt: serverTimestamp(), appVersion:'0.9.0'};

  // 데이터 보존 안전장치:
  // 프로그램 업데이트 직후 로컬 기본값([])이 기존 Firebase 배열 데이터를 덮어쓰는 것을 방지합니다.
  // 실제 삭제는 각 항목의 삭제 버튼으로 처리하고, 빈 기본값 저장은 차단합니다.
  ['expenses','investments'].forEach(key => {
    if(Array.isArray(existing[key]) && existing[key].length > 0 && Array.isArray(payload[key]) && payload[key].length === 0){
      payload[key] = existing[key];
    }
  });
  if(existing.assets?.cashItems?.length && Array.isArray(payload.assets?.cashItems) && payload.assets.cashItems.length === 0){
    payload.assets.cashItems = existing.assets.cashItems;
  }
  if(existing.investmentSummary && payload.investmentSummary){
    const emptyNew = ['domestic','overseas','cma'].every(k => !payload.investmentSummary?.[k]?.amount);
    const hasOld = ['domestic','overseas','cma'].some(k => existing.investmentSummary?.[k]?.amount);
    if(emptyNew && hasOld) payload.investmentSummary = existing.investmentSummary;
  }
  if(existing.jaturi?.history?.length && Array.isArray(payload.jaturi?.history) && payload.jaturi.history.length === 0){
    payload.jaturi.history = existing.jaturi.history;
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
