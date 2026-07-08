import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc, getDoc, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

let db = null;
let dataRef = null;
let unsubscribe = null;
let saveTimer = null;
let statusTimer = null;

export function parseFirebaseConfig(text){
  if(!text) throw new Error('Firebase 설정값이 비어 있습니다.');
  if(typeof text === 'object') return text;
  text = String(text).trim();
  const match = text.match(/firebaseConfig\s*=\s*({[\s\S]*?})\s*;?/);
  const raw = match ? match[1] : text;
  const jsonLike = raw
    .replace(/([,{]\s*)([A-Za-z0-9_]+)\s*:/g,'$1"$2":')
    .replace(/'/g,'"');
  return JSON.parse(jsonLike);
}

export function connectHousehold({ configText, householdId, onRemoteData, onMissingData, onStatus, onError }){
  try{
    const config = parseFirebaseConfig(configText);
    const app = getApps().length ? getApps()[0] : initializeApp(config);
    db = getFirestore(app);
    enableIndexedDbPersistence(db).catch(()=>{});
    dataRef = doc(db, 'households', householdId, 'app', 'data');
    onStatus?.('연결 중');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(()=>onStatus?.('연결 지연'), 8000);
    if(unsubscribe) unsubscribe();
    unsubscribe = onSnapshot(dataRef, async snap=>{
      if(snap.exists()){
        clearTimeout(statusTimer);
        onRemoteData?.(snap.data());
        onStatus?.('공동 동기화');
      }else{
        const initial = onMissingData?.() || {};
        await setDoc(dataRef, { ...initial, updatedAt: new Date().toISOString() }, { merge:false });
        clearTimeout(statusTimer);
        onStatus?.('공동 동기화');
      }
    }, err=>{
      clearTimeout(statusTimer);
      onStatus?.('동기화 오류');
      onError?.(err);
    });
  }catch(err){
    onError?.(err);
  }
}

export function saveHouseholdData(data){
  if(!dataRef) return Promise.resolve(false);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    setDoc(dataRef, { ...data, updatedAt: new Date().toISOString() }, { merge:true })
      .catch(err=>alert('Firebase 저장 오류: '+err.message));
  }, 350);
}

export function disconnectHousehold(){
  if(unsubscribe) unsubscribe();
  clearTimeout(statusTimer);
  unsubscribe = null;
  dataRef = null;
}
