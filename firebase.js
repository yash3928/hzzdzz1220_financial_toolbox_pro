import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc, getDoc, serverTimestamp, collection, runTransaction, addDoc, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';

let app = null;
let db = null;
let auth = null;
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

export async function initFirebase(config){
  if(!config || !config.projectId) throw new Error('projectId가 없습니다.');
  app = getApps().length ? getApps()[0] : initializeApp(config);
  db = getFirestore(app);
  auth = getAuth(app);
  try{
    await setPersistence(auth, browserLocalPersistence);
  }catch(err){
    console.warn('로그인 유지 설정 실패', err);
  }
  return db;
}

export function waitForInitialAuth(){
  if(!auth) throw new Error('Firebase가 초기화되지 않았습니다.');
  return new Promise(resolve=>{
    const stop=onAuthStateChanged(auth, user=>{ stop(); resolve(user||null); }, ()=>{ stop(); resolve(null); });
  });
}

export function getCurrentUser(){
  return auth?.currentUser || null;
}

export function observeAuth(callback){
  if(!auth) throw new Error('Firebase가 초기화되지 않았습니다.');
  return onAuthStateChanged(auth, callback);
}

export async function loginWithEmail(email, password){
  if(!auth) throw new Error('Firebase가 초기화되지 않았습니다.');
  const result = await signInWithEmailAndPassword(auth, String(email||'').trim(), String(password||''));
  return result.user;
}

export async function logoutFirebase(){
  if(!auth) return;
  await signOut(auth);
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
function cleanForFirestore(value){
  // undefined, 함수, DOM 객체 등 Firestore가 저장할 수 없는 값을 제거합니다.
  return JSON.parse(JSON.stringify(value ?? {}));
}

async function saveCloudBackup(existing){
  if(!activeRef || !existing || !hasMeaningfulValue(existing)) return;
  try{
    const backupsRef = collection(activeRef, 'backups');
    const clean = cleanForFirestore(existing);
    delete clean.updatedAt;
    await addDoc(backupsRef, { data: clean, savedAt: serverTimestamp(), appVersion: '1.6.1' });
  }catch(e){ console.warn('클라우드 자동 백업 실패', e); }
}

export async function saveHousehold(data, options = {}){
  if(!db) throw new Error('Firebase가 초기화되지 않았습니다.');
  if(!activeRef) throw new Error('동기화 문서가 연결되지 않았습니다.');
  const clean=cleanForFirestore(data);
  let backupData=null;
  await runTransaction(db, async transaction=>{
    const existingSnap=await transaction.get(activeRef);
    backupData=existingSnap.exists()?existingSnap.data():null;
    const payload={...clean,updatedAt:serverTimestamp(),appVersion:'1.6.1',schemaVersion:3};
    // 앱은 하나의 가계부 문서를 전체 상태로 관리합니다. merge:true를 사용하면
    // 삭제된 필드와 빈 배열이 서버에 남아 다시 복원될 수 있으므로 완전 교체합니다.
    transaction.set(activeRef,payload);
  });
  if(backupData && !options.skipBackup) await saveCloudBackup(backupData);
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
