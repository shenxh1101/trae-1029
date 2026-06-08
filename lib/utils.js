const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const {
  format,
  parseISO,
  isValid,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  subDays,
  differenceInDays,
  isSameDay
} = require('date-fns');
const { zhCN } = require('date-fns/locale');

function formatCurrency(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return '¥' + Number(num).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return Number(num).toLocaleString('zh-CN');
}

function formatPercent(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return (num * 100).toFixed(decimals) + '%';
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && isValid(value)) return startOfDay(value);
  const str = String(value).trim();
  const patterns = [
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
    /^(\d{4})(\d{2})(\d{2})$/,
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
    /^(\d{1,2})[-/](\d{1,2})$/,
  ];
  for (const pattern of patterns) {
    const match = str.match(pattern);
    if (match) {
      let year, month, day;
      if (pattern === patterns[0]) {
        [, year, month, day] = match;
      } else if (pattern === patterns[1]) {
        [, year, month, day] = match;
      } else if (pattern === patterns[2]) {
        [, month, day, year] = match;
      } else if (pattern === patterns[3]) {
        [, month, day] = match;
        year = new Date().getFullYear();
      }
      const date = new Date(Number(year), Number(month) - 1, Number(day));
      if (isValid(date)) return startOfDay(date);
    }
  }
  const parsed = parseISO(str);
  if (isValid(parsed)) return startOfDay(parsed);
  const parsed2 = new Date(str);
  if (isValid(parsed2)) return startOfDay(parsed2);
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value)
    .replace(/[,\s¥￥]/g, '')
    .replace(/\s+/g, '');
  const num = Number(str);
  if (isNaN(num)) return null;
  return num;
}

function normalizeChannelName(name) {
  if (!name) return '';
  return String(name)
    .trim()
    .replace(/\s+/g, '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[-_/\\]/g, '')
    .toLowerCase();
}

function detectColumns(headers, sampleRows = []) {
  const result = {
    dateColumn: null,
    amountColumn: null,
    channelColumn: null,
    quantityColumn: null,
  };
  const dateKeywords = ['日期', '时间', 'date', 'time', 'day', '下单时间', '创建时间', '交易时间'];
  const amountKeywords = ['金额', '价格', '金额', '收入', '销售额', '营收', 'amount', 'price', 'revenue', 'sales', 'total'];
  const channelKeywords = ['渠道', '来源', '平台', 'channel', 'source', 'platform', '媒介'];
  const quantityKeywords = ['数量', '件数', '订单数', '销量', 'quantity', 'count', 'orders', 'qty'];
  for (const header of headers) {
    const lowerHeader = header.toLowerCase();
    if (!result.dateColumn && dateKeywords.some(kw => lowerHeader.includes(kw.toLowerCase()))) {
      result.dateColumn = header;
    }
    if (!result.amountColumn && amountKeywords.some(kw => lowerHeader.includes(kw.toLowerCase()))) {
      result.amountColumn = header;
    }
    if (!result.channelColumn && channelKeywords.some(kw => lowerHeader.includes(kw.toLowerCase()))) {
      result.channelColumn = header;
    }
    if (!result.quantityColumn && quantityKeywords.some(kw => lowerHeader.includes(kw.toLowerCase()))) {
      result.quantityColumn = header;
    }
  }
  if (sampleRows.length > 0) {
    for (const header of headers) {
      if (!result.dateColumn) {
        const hasDate = sampleRows.some(row => parseDate(row[header]) !== null);
        if (hasDate) result.dateColumn = header;
      }
      if (!result.amountColumn) {
        const hasAmount = sampleRows.some(row => {
          const num = parseNumber(row[header]);
          return num !== null && Math.abs(num) > 10;
        });
        if (hasAmount) result.amountColumn = header;
      }
    }
  }
  return result;
}

function logInfo(message) {
  console.log(chalk.blue('[INFO] ') + message);
}

function logSuccess(message) {
  console.log(chalk.green('[SUCCESS] ') + message);
}

function logWarning(message) {
  console.log(chalk.yellow('[WARN] ') + message);
}

function logError(message) {
  console.log(chalk.red('[ERROR] ') + message);
}

function formatDateKey(date) {
  return format(date, 'yyyy-MM-dd');
}

function formatDateDisplay(date) {
  return format(date, 'yyyy年MM月dd日 EEEE', { locale: zhCN });
}

function getWeekRange(date) {
  return {
    start: startOfWeek(date, { weekStartsOn: 1 }),
    end: endOfWeek(date, { weekStartsOn: 1 })
  };
}

function getLastWeekRange(date) {
  const thisWeek = getWeekRange(date);
  return {
    start: subDays(thisWeek.start, 7),
    end: subDays(thisWeek.end, 7)
  };
}

function isInDateRange(date, start, end) {
  const d = startOfDay(date);
  return d >= startOfDay(start) && d <= endOfDay(end);
}

function calculateChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0) {
    return current > 0 ? Infinity : current < 0 ? -Infinity : 0;
  }
  return (current - previous) / Math.abs(previous);
}

function formatChange(change) {
  if (change === Infinity) return chalk.green('+∞%');
  if (change === -Infinity) return chalk.red('-∞%');
  const str = formatPercent(change, 1);
  if (change > 0) return chalk.green('+' + str);
  if (change < 0) return chalk.red(str);
  return chalk.gray(str);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeFileName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

module.exports = {
  formatCurrency,
  formatNumber,
  formatPercent,
  parseDate,
  parseNumber,
  normalizeChannelName,
  detectColumns,
  logInfo,
  logSuccess,
  logWarning,
  logError,
  formatDateKey,
  formatDateDisplay,
  getWeekRange,
  getLastWeekRange,
  isInDateRange,
  calculateChange,
  formatChange,
  ensureDir,
  safeFileName,
  isSameDay
};
