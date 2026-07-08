import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

let app = null;
let db = null;
let dataRef = null;
let unsubscribe = null;
let saveTimer = null;
let statusTimer = null;
let lastKey = '';

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

function initFirebase(config){
  const key = `${config.projectId || ''}_${config.appId || ''}`;
  if(app && db && lastKey === key) return { app, db };

  // 이미 Firebase 앱이 있으면 재사용합니다. Firestore persistence는 사용하지 않습니다.
  // iPhone Safari에서 persistence를 늦게 켜면 "Firestore has already been started" 오류가 발생하기 때문입니다.
  app = getApps().length ? getApps()[0] : initializeApp(config);
  db = getFirestore(app);
  lastKey = key;
  return { app, db };
}

export function connectHousehold({ configText, householdId, onRemoteData, onMissingData, onStatus, onError }){
  try{
    if(!householdId) throw new Error('가계부 코드가 비어 있습니다.');
    const config = parseFirebaseConfig(configText);
    const initialized = initFirebase(config);
    db = initialized.db;

    if(unsubscribe) unsubscribe();
    dataRef = doc(db, 'households', householdId, 'app', 'data');

    onStatus?.('연결 중');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(()=>onStatus?.('연결 지연'), 8000);

    unsubscribe = onSnapshot(dataRef, async snap=>{
      try{
        clearTimeout(statusTimer);
        if(snap.exists()){
          onRemoteData?.(snap.data());
        }else{
          const initial = onMissingData?.() || {};
          await setDoc(dataRef, { ...initial, updatedAt: new Date().toISOString() }, { merge:false });
          onRemoteData?.(initial);
        }
        onStatus?.('공동 동기화');
      }catch(innerErr){
        onStatus?.('동기화 오류');
        onError?.(innerErr);
      }
    }, err=>{
      clearTimeout(statusTimer);
      onStatus?.('동기화 오류');
      onError?.(err);
    });
  }catch(err){
    clearTimeout(statusTimer);
    onStatus?.('동기화 오류');
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
  return Promise.resolve(true);
}

export function disconnectHousehold(){
  if(unsubscribe) unsubscribe();
  clearTimeout(statusTimer);
  clearTimeout(saveTimer);
  unsubscribe = null;
  dataRef = null;
}
