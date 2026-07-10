export const $ = sel => document.querySelector(sel);
export const $$ = sel => Array.from(document.querySelectorAll(sel));
export const money = n => `${Math.round(Number(n)||0).toLocaleString('ko-KR')}원`;
export const num = v => Number(String(v ?? '').replace(/,/g,'')) || 0;
export const comma = v => {
  const n = String(v ?? '').replace(/[^0-9-]/g,'');
  if(n==='' || n==='-') return '';
  return Number(n).toLocaleString('ko-KR');
};
export function moneyInput(value){ const n=num(value); return n ? comma(n) : ''; }
export const ymd = d => d.toISOString().slice(0,10);
export function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
export function escapeAttr(s){ return escapeHtml(s).replace(/`/g,'&#96;'); }
