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
  function validateDate(y, m, d) {
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > 31) return null;
    const date = new Date(y, m - 1, d);
    if (isValid(date) &&
        date.getFullYear() === y &&
        date.getMonth() === m - 1 &&
        date.getDate() === d) {
      return startOfDay(date);
    }
    return null;
  }
  const patterns = [
    { regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, extract: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
    { regex: /^(\d{4})(\d{2})(\d{2})$/, extract: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
    { regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, extract: (m) => [Number(m[3]), Number(m[1]), Number(m[2])] },
    { regex: /^(\d{1,2})[-/](\d{1,2})$/, extract: (m) => [new Date().getFullYear(), Number(m[1]), Number(m[2])] },
  ];
  for (const { regex, extract } of patterns) {
    const match = str.match(regex);
    if (match) {
      const [y, m, d] = extract(match);
      const result = validateDate(y, m, d);
      if (result) return result;
    }
  }
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

const CHANGE_TYPE = {
  NORMAL: 'normal',
  NEW: 'new',
  NO_PREVIOUS: 'no_previous',
  NO_CURRENT: 'no_current',
  BOTH_ZERO: 'both_zero',
  INVALID: 'invalid',
};

function getChangeInfo(current, previous) {
  const currentValid = current !== null && current !== undefined && !isNaN(current);
  const previousValid = previous !== null && previous !== undefined && !isNaN(previous);
  if (!currentValid && !previousValid) {
    return { type: CHANGE_TYPE.INVALID, value: null, display: '-', displayShort: '-' };
  }
  if (!previousValid || previous === 0) {
    if (currentValid && current > 0) {
      return { type: CHANGE_TYPE.NEW, value: null, display: chalk.green('新增'), displayShort: '新增' };
    }
    if (currentValid && current < 0) {
      return { type: CHANGE_TYPE.NEW, value: null, display: chalk.red('新增(负)'), displayShort: '新增' };
    }
    if (current === 0) {
      return { type: CHANGE_TYPE.BOTH_ZERO, value: 0, display: chalk.gray('0.0%'), displayShort: '0.0%' };
    }
    return { type: CHANGE_TYPE.NO_PREVIOUS, value: null, display: chalk.gray('无上期数据'), displayShort: '-' };
  }
  if (!currentValid) {
    return { type: CHANGE_TYPE.NO_CURRENT, value: null, display: chalk.gray('无本期数据'), displayShort: '-' };
  }
  if (current === 0 && previous !== 0) {
    const value = -1;
    return { type: CHANGE_TYPE.NORMAL, value, display: chalk.red('-100.0%'), displayShort: '-100.0%' };
  }
  const value = (current - previous) / Math.abs(previous);
  const str = formatPercent(value, 1);
  let display, displayShort;
  if (value > 0) {
    display = chalk.green('+' + str);
    displayShort = '+' + str;
  } else if (value < 0) {
    display = chalk.red(str);
    displayShort = str;
  } else {
    display = chalk.gray('0.0%');
    displayShort = '0.0%';
  }
  return { type: CHANGE_TYPE.NORMAL, value, display, displayShort };
}

function calculateChange(current, previous) {
  const info = getChangeInfo(current, previous);
  return info.value;
}

function formatChange(change) {
  if (change === null || change === undefined || isNaN(change)) {
    return chalk.gray('-');
  }
  if (!isFinite(change)) {
    return change > 0 ? chalk.green('新增') : chalk.gray('-');
  }
  const str = formatPercent(change, 1);
  if (change > 0) return chalk.green('+' + str);
  if (change < 0) return chalk.red(str);
  return chalk.gray(str);
}

function formatChangeForJSON(changeInfo) {
  if (!changeInfo) {
    return { type: 'invalid', value: '无效数据', percent: '无效数据', description: '无效数据' };
  }
  if (changeInfo.type === CHANGE_TYPE.NORMAL) {
    return {
      type: changeInfo.type,
      value: changeInfo.value,
      percent: changeInfo.displayShort,
      description: changeInfo.displayShort,
    };
  }
  const description = changeInfo.displayShort;
  return {
    type: changeInfo.type,
    value: description,
    percent: description,
    description: description,
  };
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
  getChangeInfo,
  formatChangeForJSON,
  CHANGE_TYPE,
  ensureDir,
  safeFileName,
  isSameDay
};
