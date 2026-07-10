import { num } from './utils.js';

const VIEW_YEAR_KEY = 'hzzdzz_view_year';
const VIEW_MONTH_KEY = 'hzzdzz_view_month';

export const systemYear = () => new Date().getFullYear();
export const selectedYear = () => {
  const saved = num(localStorage.getItem(VIEW_YEAR_KEY));
  return Math.max(2020, Math.min(2100, saved || systemYear() || 2026));
};
export const selectedMonth = () => {
  const saved = num(localStorage.getItem(VIEW_MONTH_KEY));
  return Math.min(12, Math.max(1, saved || (new Date().getMonth()+1)));
};
export const saveLocalViewPeriod = (year, month) => {
  localStorage.setItem(VIEW_YEAR_KEY, String(year));
  localStorage.setItem(VIEW_MONTH_KEY, String(month));
};
