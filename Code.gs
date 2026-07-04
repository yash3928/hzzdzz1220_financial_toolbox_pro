/**
 * Financial Toolbox Pro API
 * - Google Sheet: 예산 / 가계부 / 가계부잔액 시트를 읽어 JSON/JSONP로 제공합니다.
 * - 배포: Apps Script > 배포 > 새 배포 > 웹 앱
 *   실행 사용자: 나
 *   액세스 권한: 모든 사용자
 */

const DEFAULT_SPREADSHEET_ID = '10Sh1km1Ts4uyHLvjTSjydkLCOy3rLEJkdQOmw2s_i1I';

function doGet(e) {
  const p = e && e.parameter ? e.parameter : {};
  const callback = p.callback || '';
  const spreadsheetId = p.spreadsheetId || DEFAULT_SPREADSHEET_ID;

  try {
    const data = buildFinancialData_(spreadsheetId);
    const output = JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), data });
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + output + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(output).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const output = JSON.stringify({ ok: false, message: String(err && err.stack ? err.stack : err) });
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + output + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(output).setMimeType(ContentService.MimeType.JSON);
  }
}

function buildFinancialData_(spreadsheetId) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const budgetSheet = ss.getSheetByName('예산');
  const ledgerSheet = ss.getSheetByName('가계부');
  const balanceSheet = ss.getSheetByName('가계부잔액');

  if (!budgetSheet || !ledgerSheet || !balanceSheet) {
    throw new Error('필수 시트(예산, 가계부, 가계부잔액)를 찾지 못했습니다.');
  }

  const budget = parseBudget_(budgetSheet.getDataRange().getValues());
  const ledger = parseLedger_(ledgerSheet.getDataRange().getValues());
  const balance = parseBalance_(balanceSheet.getDataRange().getValues());

  const months = Array.from(new Set([].concat(budget.months, ledger.months, balance.months))).sort((a,b) => monthNum_(a) - monthNum_(b));
  const monthly = {};
  months.forEach(m => {
    const b = budget.monthly[m] || emptyBudgetMonth_();
    const l = ledger.monthly[m] || emptyLedgerMonth_();
    const bal = balance.monthly[m] || { total: 0, byCategory: {}, byPayer: {} };

    const ledgerRegular = l.total - l.investment;
    const totalExpense = b.fixed + ledgerRegular + b.investment;
    const income = b.income;
    monthly[m] = {
      month: m,
      income,
      fixed: b.fixed,
      variable: ledgerRegular,
      investmentBudget: b.investment,
      investmentLedger: l.investment,
      investmentTotal: b.investment + l.investment,
      totalExpense,
      remain: income - totalExpense,
      savingRate: income ? (b.investment + l.investment) / income : 0,
      variableRate: income ? ledgerRegular / income : 0,
      budgetSurplus: b.surplus,
      balanceTotal: bal.total,
      category: l.byCategory,
      payer: l.byPayer,
      investmentCategory: l.investmentByCategory,
      balanceByCategory: bal.byCategory,
      balanceByPayer: bal.byPayer,
      entries: l.entries.slice(0, 300)
    };
  });

  return {
    spreadsheetName: ss.getName(),
    months,
    monthly,
    budget,
    ledgerSummary: {
      categories: ledger.categories,
      payers: ledger.payers,
      entriesCount: ledger.entries.length
    },
    balance
  };
}

function parseBudget_(values) {
  const row0 = values[0] || [];
  const monthStarts = [];
  row0.forEach((v, i) => {
    const m = normalizeMonth_(v);
    if (m) monthStarts.push({ month: m, col: i });
  });

  const monthly = {};
  monthStarts.forEach((mc, idx) => {
    const endCol = idx + 1 < monthStarts.length ? monthStarts[idx + 1].col : values[0].length;
    let income = 0, fixed = 0, investment = 0, surplus = null;
    const details = [];

    values.forEach((row, r) => {
      const label = String(row[0] || '').trim();
      if (!label) return;
      let sum = 0;
      for (let c = mc.col; c < endCol; c++) sum += toNumber_(row[c]);

      if (!sum && label !== '잉여') return;
      details.push({ row: r + 1, label, amount: sum });

      if (isInvestmentLabel_(label)) {
        investment += sum;
      } else if (label === '고정비') {
        fixed = sum; // 업로드 파일에 이미 고정비 합계 행이 있어 우선 사용
      } else if (label === '잉여') {
        surplus = sum;
      } else if (isIncomeRow_(label, r + 1)) {
        income += sum;
      }
    });

    if (!fixed) {
      values.forEach((row) => {
        const label = String(row[0] || '').trim();
        if (['고정','보험료','고정현금','부모님저축','청약','이자'].indexOf(label) >= 0) {
          for (let c = mc.col; c < endCol; c++) fixed += toNumber_(row[c]);
        }
      });
    }

    monthly[mc.month] = { income, fixed, investment, surplus, details };
  });

  return { months: monthStarts.map(x => x.month), monthly };
}

function parseLedger_(values) {
  const monthGroups = [];
  const top = values[0] || [];
  top.forEach((v, i) => {
    const m = normalizeMonth_(v);
    if (m) monthGroups.push({ month: m, col: i });
  });

  const monthly = {};
  const allEntries = [];
  monthGroups.forEach(g => {
    const byCategory = {}, byPayer = {}, investmentByCategory = {};
    const entries = [];
    let total = 0, investment = 0;

    for (let r = 2; r < values.length; r++) {
      const category = String(values[r][g.col] || '').trim();
      const memo = String(values[r][g.col + 1] || '').trim();
      const amount = toNumber_(values[r][g.col + 2]);
      const payer = String(values[r][g.col + 3] || '').trim() || '미지정';
      if (!category && !memo && !amount) continue;
      if (!amount) continue;

      const isInv = isInvestmentLabel_(category) || isInvestmentLabel_(memo);
      total += amount;
      if (isInv) {
        investment += amount;
        add_(investmentByCategory, category || '투자', amount);
      } else {
        add_(byCategory, category || '미분류', amount);
        add_(byPayer, payer, amount);
      }

      const entry = { month: g.month, category: category || '미분류', memo, amount, payer, investment: isInv };
      entries.push(entry);
      allEntries.push(entry);
    }
    monthly[g.month] = { total, investment, byCategory, byPayer, investmentByCategory, entries };
  });

  return {
    months: monthGroups.map(x => x.month),
    monthly,
    categories: sortedKeysFromMonthly_(monthly, 'byCategory'),
    payers: sortedKeysFromMonthly_(monthly, 'byPayer'),
    entries: allEntries
  };
}

function parseBalance_(values) {
  const headers = values[0] || [];
  const payers = values[1] || [];
  const monthly = {};
  const months = [];

  for (let r = 2; r < values.length; r++) {
    const m = normalizeMonth_(values[r][0]);
    if (!m) continue;
    months.push(m);
    const byCategory = {}, byPayer = {};
    let total = 0;
    for (let c = 1; c < values[r].length; c++) {
      const amount = toNumber_(values[r][c]);
      if (!amount) continue;
      const category = findHeaderLeft_(headers, c) || '기타';
      const payer = String(payers[c] || '').trim() || '미지정';
      add_(byCategory, category, amount);
      add_(byPayer, payer, amount);
      total += amount;
    }
    monthly[m] = { total, byCategory, byPayer };
  }

  return { months, monthly };
}

function findHeaderLeft_(headers, col) {
  for (let c = col; c >= 0; c--) {
    const h = String(headers[c] || '').trim();
    if (h) return h;
  }
  return '';
}

function emptyBudgetMonth_() {
  return { income: 0, fixed: 0, investment: 0, surplus: null, details: [] };
}
function emptyLedgerMonth_() {
  return { total: 0, investment: 0, byCategory: {}, byPayer: {}, investmentByCategory: {}, entries: [] };
}

function normalizeMonth_(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/(\d{1,2})\s*월/);
  if (!m) return '';
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n + '월' : '';
}
function monthNum_(m) {
  const r = String(m).match(/\d+/);
  return r ? Number(r[0]) : 99;
}
function toNumber_(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : 0;
}
function add_(obj, key, amount) {
  obj[key] = (obj[key] || 0) + amount;
}
function isIncomeRow_(label, rowNo) {
  if (rowNo <= 9 && !['고정','보험료','고정현금','부모님저축','투자','청약','이자','신용카드대금','고정비','특별지출','잉여'].includes(label)) return true;
  return ['월급','상여','26년 비상금','연말정산','경조사'].indexOf(label) >= 0;
}
function isInvestmentLabel_(text) {
  const s = String(text || '').toLowerCase();
  return /투자|주식|etf|코인|청약|적금|cma|isa|연금|배당|예수금|미래에셋|토스|하나머니|네이버/.test(s);
}
function sortedKeysFromMonthly_(monthly, prop) {
  const set = {};
  Object.keys(monthly).forEach(m => Object.keys(monthly[m][prop] || {}).forEach(k => set[k] = true));
  return Object.keys(set).sort();
}
