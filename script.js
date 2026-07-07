const STORAGE_KEY = 'couple-budget-v1';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 });

const state = {
  entries: JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
};

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
}

function currentMonthEntries() {
  const ym = todayISO().slice(0, 7);
  return state.entries.filter(e => e.date.startsWith(ym));
}

function sum(list, type) {
  return list.filter(e => e.type === type).reduce((acc, e) => acc + Number(e.amount), 0);
}

function renderSummary() {
  const list = currentMonthEntries();
  const income = sum(list, 'income');
  const expense = sum(list, 'expense');
  const balance = income - expense;
  const savingRate = income > 0 ? Math.round((balance / income) * 100) : 0;

  $('monthIncome').textContent = fmt.format(income);
  $('monthExpense').textContent = fmt.format(expense);
  $('monthBalance').textContent = fmt.format(balance);
  $('savingRate').textContent = `${savingRate}%`;
}

function renderOwners() {
  const list = currentMonthEntries();
  const owners = ['진혁', '다혜', '공동'];
  $('ownerStats').innerHTML = owners.map(owner => {
    const mine = list.filter(e => e.owner === owner);
    const income = sum(mine, 'income');
    const expense = sum(mine, 'expense');
    return `
      <div class="owner-card">
        <b>${owner}</b><b>${fmt.format(income - expense)}</b>
        <span>수입 ${fmt.format(income)}</span><span>지출 ${fmt.format(expense)}</span>
      </div>
    `;
  }).join('');
}

function renderEntries() {
  const sorted = [...state.entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  if (!sorted.length) {
    $('entryList').innerHTML = '<div class="empty">아직 입력된 내역이 없습니다.</div>';
    return;
  }
  $('entryList').innerHTML = sorted.map(e => `
    <div class="entry-item">
      <div class="memo">${escapeHtml(e.memo)}</div>
      <div class="amount ${e.type}">${e.type === 'expense' ? '-' : '+'}${fmt.format(e.amount)}</div>
      <div class="meta">${e.date} · ${e.owner} · ${e.category}</div>
      <button type="button" onclick="removeEntry('${e.id}')">삭제</button>
    </div>
  `).join('');
}

function renderInsights() {
  const list = currentMonthEntries();
  const income = sum(list, 'income');
  const expense = sum(list, 'expense');
  const balance = income - expense;

  const expenseList = list.filter(e => e.type === 'expense');
  const byCategory = expenseList.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + Number(e.amount);
    return acc;
  }, {});
  const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
  const savingRate = income > 0 ? Math.round((balance / income) * 100) : 0;

  const messages = [];
  if (!list.length) messages.push('이번 달 내역을 입력하면 소비 패턴을 자동으로 분석합니다.');
  if (top) messages.push(`이번 달 가장 큰 지출 분류는 ${top[0]}이며, 총 ${fmt.format(top[1])} 사용했습니다.`);
  if (income > 0) messages.push(`현재 저축률은 ${savingRate}%입니다. 목표 저축률을 정하면 달성 여부를 표시할 수 있습니다.`);
  if (expense > income && income > 0) messages.push('이번 달은 지출이 수입보다 많습니다. 공동지출과 고정지출을 먼저 점검하는 것이 좋습니다.');
  if (expenseList.length >= 5) messages.push(`이번 달 지출 입력은 ${expenseList.length}건입니다. 자주 반복되는 지출은 고정지출로 분리하면 관리가 쉬워집니다.`);

  $('insights').innerHTML = messages.map(m => `<div class="insight">${m}</div>`).join('');
}

function renderAll() {
  renderSummary();
  renderOwners();
  renderEntries();
  renderInsights();
}

function addEntry(data) {
  state.entries.push({ id: crypto.randomUUID(), ...data, amount: Number(data.amount) });
  save();
  renderAll();
}

window.removeEntry = function(id) {
  state.entries = state.entries.filter(e => e.id !== id);
  save();
  renderAll();
};

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

$('entryForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.currentTarget);
  addEntry({
    type: form.get('type'),
    owner: $('owner').value,
    date: $('date').value,
    memo: $('memo').value.trim(),
    amount: $('amount').value,
    category: $('category').value
  });
  $('memo').value = '';
  $('amount').value = '';
  $('memo').focus();
});

$('sampleBtn').addEventListener('click', () => {
  const today = todayISO();
  const samples = [
    { type: 'income', owner: '진혁', date: today, memo: '월급', amount: 3500000, category: '급여' },
    { type: 'income', owner: '다혜', date: today, memo: '월급', amount: 2700000, category: '급여' },
    { type: 'expense', owner: '공동', date: today, memo: '마트 장보기', amount: 86000, category: '식비' },
    { type: 'expense', owner: '진혁', date: today, memo: '주유', amount: 50000, category: '교통/차량' },
    { type: 'expense', owner: '다혜', date: today, memo: '카페', amount: 12000, category: '카페/간식' }
  ];
  samples.forEach(addEntry);
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('입력된 샘플/내역을 모두 삭제할까요?')) return;
  state.entries = [];
  save();
  renderAll();
});

$('date').value = todayISO();
$('todayText').textContent = todayISO();
renderAll();
