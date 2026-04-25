/*
 * FliggyParser
 * Identify expense fields from PDF / image receipts.
 *
 * Strategy (no network required by default):
 *   1. Extract any embedded text (PDF -> pdf.js if available; image -> filename + EXIF date).
 *   2. Run keyword + regex heuristics over the combined text + filename to detect:
 *        - type: flight | hotel | meal | taxi | other
 *        - date: YYYY-MM-DD
 *        - currency: ISO code (CNY default)
 *        - amount: number
 *        - note: <=20 char summary
 *
 * Optional: if the user configures an OCR/LLM endpoint in Options,
 * it will be called as a second pass to refine results.
 */
(function (global) {
  const TYPE_KEYWORDS = {
    flight: [
      "机票",
      "航班",
      "登机",
      "boarding",
      "airline",
      "flight",
      "国航",
      "东航",
      "南航",
      "海航",
      "厦航",
      "深航",
      "春秋",
      "吉祥",
      "山航",
      "川航",
      "ana",
      "jal",
      "delta",
      "united",
      "lufthansa",
      "电子客票",
      "行程单",
    ],
    hotel: [
      "酒店",
      "宾馆",
      "客房",
      "住宿",
      "hotel",
      "inn",
      "resort",
      "如家",
      "汉庭",
      "全季",
      "亚朵",
      "锦江",
      "万豪",
      "希尔顿",
      "洲际",
      "凯悦",
      "雅高",
      "marriott",
      "hilton",
      "hyatt",
      "ihg",
      "accor",
    ],
    meal: [
      "餐饮",
      "餐厅",
      "餐费",
      "饭店",
      "美食",
      "restaurant",
      "cafe",
      "coffee",
      "starbucks",
      "麦当劳",
      "肯德基",
      "kfc",
      "mcdonald",
      "海底捞",
      "外卖",
      "美团",
      "饿了么",
      "diner",
      "lunch",
      "dinner",
      "breakfast",
    ],
    taxi: [
      "出租",
      "打车",
      "网约车",
      "滴滴",
      "曹操",
      "高德",
      "uber",
      "didi",
      "taxi",
      "cab",
      "lyft",
      "ride",
      "首汽",
      "T3",
      "行程",
      "里程",
    ],
  };

  const CURRENCY_MAP = [
    [/(?:¥|￥|RMB|CNY|人民币|元)/i, "CNY"],
    [/(?:US\$|USD|\$)/i, "USD"],
    [/(?:€|EUR|欧元)/i, "EUR"],
    [/(?:£|GBP|英镑)/i, "GBP"],
    [/(?:¥|JPY|日元|円)/i, "JPY"],
    [/(?:HK\$|HKD|港币)/i, "HKD"],
    [/(?:S\$|SGD|新币)/i, "SGD"],
  ];

  async function parseFile(file) {
    const filename = file.name;
    const ext = (filename.split(".").pop() || "").toLowerCase();
    console.log("[FliggyParser] parsing", filename, `(${file.type || ext}, ${file.size}B)`);
    let text = "";
    let exifDate = null;

    if (ext === "pdf") {
      text = await safe(() => extractPdfText(file), "");
      console.log("[FliggyParser] pdf text length:", text.length);
    } else {
      exifDate = await safe(() => extractImageDate(file), null);
      console.log("[FliggyParser] image exif/date:", exifDate);
    }

    const combined = `${filename}\n${text}`;
    const heuristic = runHeuristics(combined, filename);

    let date = heuristic.date || exifDate || todayISO();
    let amount = heuristic.amount;
    let currency = heuristic.currency || "CNY";
    let type = heuristic.type || guessTypeFromFilename(filename) || "other";

    // Try optional remote OCR refinement
    const refined = await safe(() => remoteRefine(file, { type, date, amount, currency }), null);
    if (refined && typeof refined === "object") {
      console.log("[FliggyParser] remote refined:", refined);
      type = refined.type || type;
      date = refined.date || date;
      amount = refined.amount ?? amount;
      currency = refined.currency || currency;
    }

    const note = buildNote(type, combined, filename, amount, currency);

    const rec = {
      type,
      date,
      currency,
      amount: amount ?? 0,
      note,
      source: filename,
    };
    console.log("[FliggyParser] →", rec);
    return rec;
  }

  function fallbackRecord(file, errMsg) {
    return {
      type: guessTypeFromFilename(file.name) || "other",
      date: todayISO(),
      currency: "CNY",
      amount: 0,
      note: errMsg ? `解析失败: ${errMsg}`.slice(0, 20) : file.name.slice(0, 20),
      source: file.name,
    };
  }

  /* ---------- Heuristics ---------- */
  function runHeuristics(text, filename) {
    const out = {};
    out.type = detectType(text);
    out.date = detectDate(text);
    const amt = detectAmount(text);
    if (amt) {
      out.amount = amt.value;
      out.currency = amt.currency;
    }
    if (!out.currency) out.currency = detectCurrency(text);
    return out;
  }

  function detectType(text) {
    const lower = text.toLowerCase();
    let bestType = null;
    let bestScore = 0;
    for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
      let score = 0;
      for (const w of words) {
        if (lower.includes(w.toLowerCase())) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
    return bestType;
  }

  function guessTypeFromFilename(name) {
    const lower = name.toLowerCase();
    for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
      for (const w of words) {
        if (lower.includes(w.toLowerCase())) return type;
      }
    }
    return null;
  }

  function detectDate(text) {
    // Patterns: 2026-04-25, 2026/04/25, 2026.04.25, 2026年4月25日, 25/04/2026
    const patterns = [
      /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/,
      /(\d{1,2})[-/](\d{1,2})[-/](20\d{2})/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        let y, mo, d;
        if (m[1].length === 4) {
          y = +m[1];
          mo = +m[2];
          d = +m[3];
        } else {
          d = +m[1];
          mo = +m[2];
          y = +m[3];
        }
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
          return `${y}-${pad(mo)}-${pad(d)}`;
        }
      }
    }
    return null;
  }

  function detectAmount(text) {
    // Find currency-prefixed amount, prefer largest "total"-like number
    const candidates = [];
    const re =
      /(¥|￥|US\$|HK\$|S\$|\$|€|£|RMB|CNY|USD|EUR|GBP|JPY|HKD|SGD)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
    let m;
    while ((m = re.exec(text))) {
      const cur = normalizeCurrency(m[1]);
      const val = parseFloat(m[2].replace(/,/g, ""));
      if (!isNaN(val)) candidates.push({ value: val, currency: cur });
    }
    // amounts near "合计" / "total"
    const totalRe =
      /(?:合计|总计|应付|实付|金额|total|amount|grand total)[^\d]{0,12}([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
    let mt;
    while ((mt = totalRe.exec(text))) {
      const val = parseFloat(mt[1].replace(/,/g, ""));
      if (!isNaN(val)) candidates.push({ value: val, currency: detectCurrency(text) || "CNY", isTotal: true });
    }
    if (candidates.length === 0) return null;
    // Prefer total-tagged, then largest
    candidates.sort((a, b) => {
      if (!!b.isTotal - !!a.isTotal !== 0) return !!b.isTotal - !!a.isTotal;
      return b.value - a.value;
    });
    return candidates[0];
  }

  function normalizeCurrency(sym) {
    const s = sym.trim().toUpperCase();
    if (s === "¥" || s === "￥" || s === "RMB" || s === "CNY") return "CNY";
    if (s === "US$" || s === "USD" || s === "$") return "USD";
    if (s === "€" || s === "EUR") return "EUR";
    if (s === "£" || s === "GBP") return "GBP";
    if (s === "JPY") return "JPY";
    if (s === "HK$" || s === "HKD") return "HKD";
    if (s === "S$" || s === "SGD") return "SGD";
    return "CNY";
  }

  function detectCurrency(text) {
    for (const [re, code] of CURRENCY_MAP) {
      if (re.test(text)) return code;
    }
    return null;
  }

  function buildNote(type, text, filename, amount, currency) {
    // Build a <=20 char summary based on type and clues.
    const cleanFn = filename.replace(/\.[a-z0-9]+$/i, "");
    const merchantCues = extractMerchant(text);
    const cityCues = extractCity(text);

    const parts = [];
    if (type === "flight") {
      const route = extractRoute(text);
      parts.push(route || "机票");
    } else if (type === "hotel") {
      parts.push(merchantCues || cityCues || "酒店住宿");
    } else if (type === "meal") {
      parts.push(merchantCues || "餐饮");
    } else if (type === "taxi") {
      parts.push(cityCues ? `${cityCues}打车` : "市内打车");
    } else {
      parts.push(merchantCues || cleanFn.slice(0, 12));
    }
    let s = parts.filter(Boolean).join(" ").trim();
    if (!s) s = cleanFn;
    if (s.length > 20) s = s.slice(0, 20);
    return s;
  }

  function extractMerchant(text) {
    // Look for lines like "XX酒店" / "XX餐厅" / "XX店"
    const re = /([一-龥A-Za-z0-9·]{2,10}(?:酒店|宾馆|大饭店|餐厅|饭店|咖啡|店))/;
    const m = text.match(re);
    return m ? m[1] : null;
  }

  function extractCity(text) {
    const cities = [
      "北京",
      "上海",
      "杭州",
      "广州",
      "深圳",
      "成都",
      "重庆",
      "武汉",
      "南京",
      "苏州",
      "西安",
      "天津",
      "厦门",
      "青岛",
      "长沙",
      "郑州",
      "合肥",
      "宁波",
      "佛山",
      "东莞",
      "香港",
      "澳门",
      "台北",
    ];
    for (const c of cities) if (text.includes(c)) return c;
    return null;
  }

  function extractRoute(text) {
    // "PEK-PVG" / "北京-上海"
    const re1 = /\b([A-Z]{3})\s*[-→/]\s*([A-Z]{3})\b/;
    const m1 = text.match(re1);
    if (m1) return `${m1[1]}-${m1[2]}`;
    const re2 = /([一-龥]{2,3})\s*[-→/]\s*([一-龥]{2,3})/;
    const m2 = text.match(re2);
    if (m2) return `${m2[1]}-${m2[2]}`;
    return null;
  }

  /* ---------- PDF text extraction (pdf.js when available) ---------- */
  async function extractPdfText(file) {
    if (!global.pdfjsLib) {
      try {
        const url = chrome.runtime.getURL("lib/pdf.min.js");
        await loadScript(url);
        if (global.pdfjsLib) {
          global.pdfjsLib.GlobalWorkerOptions.workerSrc =
            chrome.runtime.getURL("lib/pdf.worker.min.js");
        }
      } catch (e) {
        // pdf.js not bundled; fall through to filename-only parsing
      }
    }
    if (!global.pdfjsLib) return "";
    const buf = await file.arrayBuffer();
    const pdf = await global.pdfjsLib.getDocument({ data: buf }).promise;
    const pages = Math.min(pdf.numPages, 5); // first few pages are enough
    const out = [];
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map((it) => it.str).join(" "));
    }
    return out.join("\n");
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /* ---------- Image EXIF date (best effort) ---------- */
  async function extractImageDate(file) {
    if (!/jpe?g|tiff?/i.test(file.type)) {
      const m = file.name.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      // fallback to file lastModified
      return new Date(file.lastModified).toISOString().slice(0, 10);
    }
    try {
      const buf = await file.slice(0, 128 * 1024).arrayBuffer();
      const view = new DataView(buf);
      // Find EXIF DateTimeOriginal tag (0x9003) - simplified
      // If parsing is too brittle we just use lastModified
      const text = new TextDecoder("ascii").decode(buf);
      const m = text.match(/(20\d{2})[:\-](\d{2})[:\-](\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    } catch (e) {
      /* ignore */
    }
    return new Date(file.lastModified).toISOString().slice(0, 10);
  }

  /* ---------- Optional remote OCR/LLM refinement ---------- */
  async function remoteRefine(file, draft) {
    let cfg;
    try {
      cfg = await chrome.storage.sync.get([
        "fliggy.ocr.endpoint",
        "fliggy.ocr.apiKey",
        "fliggy.ocr.enabled",
      ]);
    } catch (e) {
      return null;
    }
    if (!cfg["fliggy.ocr.enabled"] || !cfg["fliggy.ocr.endpoint"]) return null;

    const b64 = await fileToBase64(file);
    const body = {
      filename: file.name,
      mime: file.type,
      data: b64,
      draft,
    };
    try {
      const resp = await fetch(cfg["fliggy.ocr.endpoint"], {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg["fliggy.ocr.apiKey"]
            ? { Authorization: `Bearer ${cfg["fliggy.ocr.apiKey"]}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = fr.result || "";
        const idx = s.indexOf(",");
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  /* ---------- Utils ---------- */
  function pad(n) {
    return n < 10 ? `0${n}` : `${n}`;
  }
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  async function safe(fn, fallback) {
    try {
      return await fn();
    } catch (e) {
      return fallback;
    }
  }

  global.FliggyParser = { parseFile, fallbackRecord };
})(typeof window !== "undefined" ? window : globalThis);
