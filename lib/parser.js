/*
 * FliggyParser
 * Identify expense fields from PDF / image receipts.
 *
 * Strategy (fully offline by default):
 *   1. Extract embedded text:
 *        - PDF  -> pdf.js (Mozilla, bundled in lib/)
 *        - image -> tesseract.js OCR (chi_sim + eng, bundled in lib/tesseract/)
 *   2. Run keyword + regex heuristics over the combined text + filename to detect:
 *        - type: flight | hotel | meal | taxi | other
 *        - date: YYYY-MM-DD
 *        - currency: ISO code (CNY default)
 *        - amount: number
 *        - note: <=20 char summary
 *
 * Optional: if the user configures an OCR/LLM endpoint in Options,
 * it is called as a second pass to refine results.
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

  // Used by the global `detectCurrency` text scan. ONLY textual markers
  // (ISO codes + Chinese names + 2-char prefixes like US$/HK$/S$) — bare
  // glyphs like ¥/￥/£/€/$ are intentionally absent because tesseract OCR
  // routinely produces stray currency glyphs (¥↔£ misreads are common) and
  // we'd rather keep the safe CNY default than mislabel a domestic receipt.
  const CURRENCY_MAP = [
    [/(?:RMB|\bCNY\b|人民币)/i, "CNY"],
    [/(?:US\$|\bUSD\b|美元|美金)/i, "USD"],
    [/(?:\bEUR\b|欧元)/i, "EUR"],
    [/(?:\bGBP\b|英镑)/i, "GBP"],
    [/(?:\bJPY\b|日元|円)/i, "JPY"],
    [/(?:HK\$|\bHKD\b|港币|港元)/i, "HKD"],
    [/(?:\bSGD\b|新币|新加坡元)/i, "SGD"],
  ];

  async function parseFile(file, opts) {
    const filename = file.name;
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const onProgress = (opts && opts.onProgress) || (() => {});
    console.log("[FliggyParser] parsing", filename, `(${file.type || ext}, ${file.size}B)`);
    let text = "";
    let exifDate = null;

    if (ext === "pdf" || /^application\/pdf$/i.test(file.type)) {
      text = await safe(() => extractPdfText(file), "");
      console.log("[FliggyParser] pdf text length:", text.length);
    } else if (isImage(file, ext)) {
      exifDate = await safe(() => extractImageDate(file), null);
      console.log("[FliggyParser] image exif/date:", exifDate);
      const cfg = await getOcrConfig();
      if (cfg.localEnabled) {
        const ocrText = await safe(
          () => runImageOcr(file, { onProgress, langs: cfg.langs }),
          "",
        );
        if (ocrText) {
          text = ocrText;
          console.log("[FliggyParser] ocr text length:", text.length);
        }
      }
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
      _debug: {
        amountSource: heuristic.amountSource || (refined ? "remote" : "none"),
        textPreview: text ? text.slice(0, 240) : "",
        textLength: text.length,
      },
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
    const amt = detectAmount(text, filename);
    if (amt) {
      out.amount = amt.value;
      out.amountSource = amt.why;
      // Confidence guard: detectAmount can match on bare glyphs (£/€/$) which
      // OCR routinely confuses with ¥. Only keep a non-CNY currency if it's
      // corroborated by an unambiguous textual marker via detectCurrency
      // (codes/names — glyphs no longer count). Otherwise fall back to CNY.
      const textual = detectCurrency(text);
      out.currency = (amt.currency === "CNY" || amt.currency === textual)
        ? amt.currency
        : (textual || "CNY");
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

  function detectAmount(text, filename) {
    // OCR pre-clean: collapse whitespace inside Chinese label words so things
    // like "合 计" or "价 税 合 计" still match. Also normalise common OCR
    // misreads of the ¥ glyph.
    const normText = text
      .replace(/[ \t]+/g, " ")
      // 价税合计 / 小写 / 合计 / 总计 — strip spaces between Chinese chars
      .replace(/(?<=[一-龥])\s+(?=[一-龥])/g, "");
    // Tolerant currency token: includes Y/￥/¥ and common OCR variants.
    // 元 is the Chinese yuan suffix used by 滴滴 / WeChat / e-receipts.
    // Y is OCR-ambiguous so only accept when followed by digits.
    // Bare "$" is intentionally absent — "$35" is too easily a stray dollar
    // sign in OCR noise; we'd rather catch the amount via the bare-decimal
    // pass and keep the currency as the CNY default than mislabel it as USD.
    const CURTOK_PRE = "(?:¥|￥|RMB|CNY|US\\$|HK\\$|S\\$|€|£|USD|EUR|GBP|JPY|HKD|SGD|Y(?=\\d))";
    // Suffix variant additionally allows 元.
    const CURTOK_SUF = "(?:¥|￥|RMB|CNY|US\\$|HK\\$|S\\$|€|£|USD|EUR|GBP|JPY|HKD|SGD|元)";
    // Make sure the currency token isn't part of a longer word like "元宝".
    const NOT_LETTER = "(?![一-龥A-Za-z])";
    const NUM = "([0-9][0-9,]{0,9}(?:\\.\\d{1,2})?)";
    // Reject any candidate where the matched number is preceded by a minus
    // sign — those are discounts, not totals.
    const isNegative = (idx) => {
      const c = normText.charAt(idx - 1);
      return c === "-" || c === "−" || c === "–";
    };
    const candidates = [];

    // 1a. Numbers immediately preceded by a currency token ("¥35.00").
    const reCur = new RegExp(`(${CURTOK_PRE})\\s*${NUM}`, "gi");
    let m;
    while ((m = reCur.exec(normText))) {
      // m.index points to the currency token; the number starts later.
      const numIdx = m.index + m[1].length + (m[0].length - m[1].length - m[2].length);
      if (isNegative(m.index)) continue;
      const cur = normalizeCurrency(m[1]);
      const val = parseFloat(m[2].replace(/,/g, ""));
      if (isPlausibleAmount(val)) {
        candidates.push({ value: val, currency: cur, score: 2, why: "currency-prefix" });
      }
    }

    // 1b. Numbers immediately FOLLOWED by a currency token ("684.44 CNY",
    // "85.2元"). Common on hotel confirmations and Chinese ride/food apps.
    const reSuffix = new RegExp(`${NUM}\\s*(${CURTOK_SUF})${NOT_LETTER}`, "g");
    while ((m = reSuffix.exec(normText))) {
      if (isNegative(m.index)) continue;
      const cur = normalizeCurrency(m[2]);
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (isPlausibleAmount(val)) {
        candidates.push({ value: val, currency: cur, score: 2, why: "currency-suffix" });
      }
    }

    // 2. Numbers near a "total" keyword. Increased keyword set + small window.
    const TOTAL_WORDS = [
      // VAT invoice
      "价税合计", "含税合计", "税价合计", "小写",
      // Generic totals
      "金额合计", "费用合计", "合计", "总计", "总额", "总金额",
      "总价",
      // Payment-style labels
      "应付", "实付", "实收", "应收", "实付金额", "实际应收金额",
      "应付金额", "实收金额",
      // Hotel-specific
      "总住宿费", "住宿费", "房费",
      // Misc
      "票面金额", "金额",
      // English
      "total amount", "grand total", "amount due", "total", "amount", "subtotal",
    ];
    // Sort longest-first so "价税合计" wins over "合计" inside the same span.
    const keywordAlt = TOTAL_WORDS
      .sort((a, b) => b.length - a.length)
      .map((w) => w.replace(/\s+/g, "\\s*"))
      .join("|");
    // Capture the keyword AND a 30-char window after it. Then within that
    // window, pick the LARGEST number — handles tabular rows like
    // "合计 7.00 526.00" where the first number is the item count and the
    // last is the total.
    const reTotal = new RegExp(`(?:${keywordAlt})([^\\n]{0,30})`, "gi");
    while ((m = reTotal.exec(normText))) {
      const window = m[1];
      const winStart = m.index + m[0].length - window.length;
      const numRe = new RegExp(NUM, "g");
      let nm;
      let best = null;
      while ((nm = numRe.exec(window))) {
        if (isNegative(winStart + nm.index)) continue;
        const val = parseFloat(nm[1].replace(/,/g, ""));
        if (!isPlausibleAmount(val)) continue;
        if (best === null || val > best) best = val;
      }
      if (best === null) continue;
      // Currency: nearest token in the same window, else doc-level guess.
      const curTok = window.match(new RegExp(CURTOK_SUF, "i"));
      const cur = curTok ? normalizeCurrency(curTok[0]) : detectCurrency(normText) || "CNY";
      candidates.push({ value: best, currency: cur, score: 3, why: "total-keyword" });
    }

    // 3. Plain receipt fallback: many 收据 / POS prints have NO label and NO
    // currency glyph (or tesseract dropped the ¥). Take any decimal number
    // that looks like a price (>= 1 and has cents). Score lower than tagged
    // candidates so labelled totals still win when present.
    const reBare = /(?<![\d.,\-−])(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})(?![\d])/g;
    while ((m = reBare.exec(normText))) {
      if (isNegative(m.index)) continue;
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (isPlausibleAmount(val) && val >= 1) {
        candidates.push({
          value: val,
          currency: detectCurrency(normText) || "CNY",
          score: 1,
          why: "bare-decimal",
        });
      }
    }

    // 5. Filename fallback: users often name receipts like "深圳酒店684.44.png".
    // Look for a number with a decimal point or one >= 10 in the filename
    // stem; ignore anything that looks like a date.
    if (filename) {
      const stem = filename.replace(/\.[a-z0-9]+$/i, "");
      const reFn = /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})|\d+\.\d{1,2}|\d{2,7})/g;
      let fm;
      while ((fm = reFn.exec(stem))) {
        const raw = fm[1];
        if (looksLikeDate(raw, stem, fm.index)) continue;
        const val = parseFloat(raw.replace(/,/g, ""));
        if (isPlausibleAmount(val)) {
          candidates.push({ value: val, currency: detectCurrency(stem) || "CNY", score: 1, why: "filename" });
        }
      }
    }

    if (candidates.length === 0) return null;
    // Highest score wins; tiebreak by larger value (totals are usually largest).
    candidates.sort((a, b) => (b.score - a.score) || (b.value - a.value));
    console.log("[FliggyParser] amount candidates:", candidates.slice(0, 6));
    return candidates[0];
  }

  function isPlausibleAmount(v) {
    if (isNaN(v)) return false;
    if (v <= 0) return false;
    if (v > 1_000_000) return false; // not a single-receipt amount
    return true;
  }

  // Filter out tokens that look like dates / years embedded in filenames.
  function looksLikeDate(raw, stem, idx) {
    if (/^20\d{2}$/.test(raw)) return true; // bare year
    if (/^(19|20)\d{6}$/.test(raw)) return true; // YYYYMMDD
    // YYYY-MM-DD / YYYY_MM_DD context
    const around = stem.slice(Math.max(0, idx - 2), idx + raw.length + 2);
    if (/20\d{2}[-_/.]\d{1,2}[-_/.]\d{1,2}/.test(around)) return true;
    return false;
  }

  function normalizeCurrency(sym) {
    const s = sym.trim().toUpperCase();
    if (s === "¥" || s === "￥" || s === "Y" || s === "RMB" || s === "CNY" || s === "元") return "CNY";
    if (s === "US$" || s === "USD") return "USD";
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

  /* ---------- PDF text extraction (bundled pdf.js) ---------- */
  let pdfjsConfigured = false;
  function ensurePdfJs() {
    if (!global.pdfjsLib) return false;
    if (!pdfjsConfigured) {
      try {
        global.pdfjsLib.GlobalWorkerOptions.workerSrc =
          chrome.runtime.getURL("lib/pdf.worker.min.js");
        pdfjsConfigured = true;
      } catch (e) {
        console.warn("[FliggyParser] pdf.js worker config failed:", e);
      }
    }
    return true;
  }

  async function extractPdfText(file) {
    if (!ensurePdfJs()) {
      console.warn("[FliggyParser] pdfjsLib not loaded; skipping PDF text extraction");
      return "";
    }
    const buf = await file.arrayBuffer();
    const pdf = await global.pdfjsLib.getDocument({ data: buf }).promise;
    const pages = Math.min(pdf.numPages, 5); // first few pages are enough
    const out = [];
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map((it) => it.str).join(" "));
    }
    try { await pdf.cleanup(); pdf.destroy && pdf.destroy(); } catch {}
    return out.join("\n");
  }

  /* ---------- Image OCR (bundled tesseract.js) ---------- */
  function isImage(file, ext) {
    if (file.type && /^image\//i.test(file.type)) return true;
    return ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"].includes(ext);
  }

  // Tesseract.js v5 cannot decode HEIC/HEIF natively. Other formats are fine.
  function isOcrCapable(file, ext) {
    if (ext === "heic" || ext === "heif") return false;
    if (/heic|heif/i.test(file.type || "")) return false;
    return isImage(file, ext);
  }

  let _ocrWorker = null;
  let _ocrWorkerLangs = "";
  async function getOcrWorker(langs) {
    if (!global.Tesseract) {
      console.warn("[FliggyParser] Tesseract not loaded; skipping OCR");
      return null;
    }
    const langKey = (langs || "chi_sim+eng").trim();
    if (_ocrWorker && _ocrWorkerLangs === langKey) return _ocrWorker;
    if (_ocrWorker) {
      try { await _ocrWorker.terminate(); } catch {}
      _ocrWorker = null;
    }
    const workerPath = chrome.runtime.getURL("lib/tesseract/worker.min.js");
    const corePath = chrome.runtime.getURL("lib/tesseract/");
    const langPath = chrome.runtime.getURL("lib/tesseract/lang/");
    try {
      _ocrWorker = await global.Tesseract.createWorker(langKey, 1, {
        workerPath,
        corePath,
        langPath,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: "none",
        logger: (m) => {
          if (m && m.status) {
            console.log(`[FliggyParser ocr] ${m.status} ${(m.progress * 100 || 0).toFixed(0)}%`);
          }
        },
      });
      // Receipt layout heuristic: PSM 6 = single uniform block of text.
      // This dramatically improves digit recognition on tabular receipts
      // versus the default PSM 3 (auto-segment).
      try {
        await _ocrWorker.setParameters({
          tessedit_pageseg_mode: "6",
          // Bias the recognizer toward characters we actually need.
          preserve_interword_spaces: "1",
        });
      } catch (e) {
        console.warn("[FliggyParser] setParameters failed:", e);
      }
      _ocrWorkerLangs = langKey;
      return _ocrWorker;
    } catch (e) {
      console.warn("[FliggyParser] Tesseract worker init failed:", e);
      _ocrWorker = null;
      return null;
    }
  }

  async function runImageOcr(file, { onProgress, langs } = {}) {
    if (!isOcrCapable(file, (file.name.split(".").pop() || "").toLowerCase())) return "";
    const worker = await getOcrWorker(langs);
    if (!worker) return "";
    try {
      onProgress && onProgress({ stage: "ocr", file: file.name });
      const { data } = await worker.recognize(file);
      const text = (data && data.text) || "";
      return text.replace(/\s+\n/g, "\n").trim();
    } catch (e) {
      console.warn("[FliggyParser] ocr failed:", file.name, e);
      return "";
    }
  }

  async function terminateOcr() {
    if (_ocrWorker) {
      try { await _ocrWorker.terminate(); } catch {}
      _ocrWorker = null;
      _ocrWorkerLangs = "";
    }
  }

  /* ---------- OCR config ---------- */
  async function getOcrConfig() {
    let cfg = {};
    try {
      cfg = await chrome.storage.sync.get([
        "fliggy.ocr.local",
        "fliggy.ocr.langs",
      ]);
    } catch (e) {
      cfg = {};
    }
    const local = cfg["fliggy.ocr.local"];
    return {
      localEnabled: local !== false, // default ON
      langs: cfg["fliggy.ocr.langs"] || "chi_sim+eng",
    };
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

  global.FliggyParser = { parseFile, fallbackRecord, terminateOcr };
})(typeof window !== "undefined" ? window : globalThis);
