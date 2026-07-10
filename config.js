export const APP_VERSION = '1.4.9';
export const SCHEMA_VERSION = 1;
export const DEFAULT_HOUSEHOLD = 'hzzdzz_가계부';
export const MONTHLY_CATEGORIES = ['식비'];
export const YEARLY_CATEGORIES = ['생필품','비상금','쇼핑비','가족','경조사비','육아'];
export const EXPENSE_CATEGORIES = ['식비','생필품','비상금','쇼핑비(진혁)','쇼핑비(다혜)','가족','경조사비','육아'];
export const PURPOSE_ASSETS = ['연금','청약','코인','기타'];
export const DEFAULT_RATES = {weekday:77330, holiday:284470, sunday:163640, monThu:10000, friday:20000};
export const DEFAULT_TAX = {
  pensionRate:4.75,
  taxHealthRate:3.595,
  taxCareRate:13.14,
  taxEmploymentRate:0.9,
  incomeTax:58750,
  taxLocal:5870,
  otherDeduct:0,
  vehicleAllowance:0,
  memoDeduct:0
};

export const DEFAULT_LOAN = {
  name:'신한은행 주택담보대출',
  originalPrincipal:340000000,
  annualRate:2.85,
  repaymentStart:'2025-09-30',
  maturityDate:'2054-08-30',
  totalInstallments:348,
  monthlyPaymentIncrease:4200,
  paidInstallments:10,
  currentBalance:339809795,
  lastPaidPrincipal:38162
};
